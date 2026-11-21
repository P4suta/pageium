use std::{path::PathBuf, process::Stdio, time::Duration};

use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, ChildStdout, Command},
    sync::Mutex,
    time::timeout,
};

#[derive(Deserialize, Serialize)]
pub(crate) struct Matches {
    pages: u32,
    hits: Vec<(u32, u32, u32)>,
}

pub(crate) struct Matcher {
    script: PathBuf,
    database: PathBuf,
    revision: &'static str,
    process: Mutex<Option<Process>>,
}

struct Process {
    _child: Child,
    input: ChildStdin,
    output: BufReader<ChildStdout>,
}

impl Matcher {
    pub(crate) fn new(script: PathBuf, database: PathBuf, revision: &'static str) -> Self {
        Self {
            script,
            database,
            revision,
            process: Mutex::new(None),
        }
    }

    fn start(&self) -> Result<Process> {
        let mut child = Command::new("node")
            .arg("--max-old-space-size=384")
            .arg(&self.script)
            .arg(&self.database)
            .arg(self.revision)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()?;
        Ok(Process {
            input: child.stdin.take().context("Missing search input")?,
            output: BufReader::new(child.stdout.take().context("Missing search output")?),
            _child: child,
        })
    }

    pub(crate) async fn warm(&self) {
        if let Ok(mut slot) = self.process.try_lock()
            && slot.is_none()
            && self.script.is_file()
        {
            *slot = self.start().ok();
        }
    }

    pub(crate) async fn find(&self, id: &str, query: &str) -> Result<Option<Matches>> {
        let mut slot = self.process.lock().await;
        // A cancelled exchange drops the child before another request can read its response.
        let mut worker = match slot.take() {
            Some(process) => process,
            None => self.start()?,
        };
        let reply = timeout(Duration::from_secs(8), async {
            let mut message = serde_json::to_vec(&(id, query))?;
            message.push(b'\n');
            worker.input.write_all(&message).await?;
            let mut line = Vec::new();
            (&mut worker.output)
                .take(2 * 1024 * 1024)
                .read_until(b'\n', &mut line)
                .await?;
            ensure!(line.last() == Some(&b'\n'), "Incomplete match response");
            Ok::<_, anyhow::Error>(serde_json::from_slice(&line)?)
        })
        .await??;
        *slot = Some(worker);
        Ok(reply)
    }
}
