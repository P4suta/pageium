#![cfg(unix)]

use std::{
    fs,
    io::{Read, Write},
    net::{SocketAddr, TcpStream},
    process::{Child, Command, Stdio},
    thread,
    time::{Duration, Instant},
};

use anyhow::{Result, bail, ensure};

struct Server(Child);

impl Drop for Server {
    fn drop(&mut self) {
        if matches!(self.0.try_wait(), Ok(None)) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
}

fn poll<T>(mut check: impl FnMut() -> Result<Option<T>>) -> Result<T> {
    let deadline = Instant::now() + Duration::from_secs(6);
    loop {
        if let Some(value) = check()? {
            return Ok(value);
        }
        ensure!(
            Instant::now() < deadline,
            "The server did not reach the expected state"
        );
        thread::sleep(Duration::from_millis(20));
    }
}

#[test]
fn serves_http_and_shuts_down_on_sigterm() -> Result<()> {
    let root = tempfile::tempdir()?;
    let books = root.path().join("books");
    let web = root.path().join("web");
    let log = root.path().join("stderr");
    fs::create_dir(&books)?;
    fs::create_dir(&web)?;
    fs::write(web.join("index.html"), b"Pageium")?;
    let mut server = Server(
        Command::new(env!("CARGO_BIN_EXE_pageium"))
            .arg("--books")
            .arg(&books)
            .arg("--state")
            .arg(root.path().join("state"))
            .arg("--web")
            .arg(&web)
            .args(["--listen", "127.0.0.1:0"])
            .env("NO_COLOR", "1")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(fs::File::create(&log)?)
            .spawn()?,
    );
    let address = poll(|| {
        if let Some(status) = server.0.try_wait()? {
            bail!("Pageium exited before it was ready: {status}");
        }
        Ok(fs::read_to_string(&log)?
            .split_whitespace()
            .find_map(|word| word.strip_prefix("listen="))
            .and_then(|address| address.parse::<SocketAddr>().ok()))
    })?;
    let mut socket = TcpStream::connect_timeout(&address, Duration::from_secs(2))?;
    socket.set_read_timeout(Some(Duration::from_secs(2)))?;
    socket.write_all(b"GET /healthz HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")?;
    let mut reply = String::new();
    socket.read_to_string(&mut reply)?;
    assert!(reply.starts_with("HTTP/1.1 204 "), "{reply}");
    assert!(
        Command::new("kill")
            .arg("-TERM")
            .arg(server.0.id().to_string())
            .status()?
            .success()
    );
    assert!(poll(|| Ok(server.0.try_wait()?))?.success());
    Ok(())
}
