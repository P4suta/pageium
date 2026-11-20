use std::{fs::File, path::Path, process::Stdio, sync::Arc, time::Duration};

use axum::{body::Bytes, http::StatusCode};
use rusqlite::{OptionalExtension, params};
use tokio::{process::Command, sync::Mutex, time::timeout};

use crate::{
    books::{Book, Source},
    database::Database,
};

pub(crate) struct Previews {
    cache: Option<Database>,
    renderer: Mutex<()>,
}

const CACHE_BYTES: i64 = 32 * 1024 * 1024;

impl Previews {
    pub(crate) fn open(state: &Path) -> Self {
        let cache = Database::open(
            &state.join("previews.sqlite3"),
            "CREATE TABLE IF NOT EXISTS previews (book TEXT NOT NULL, page INTEGER NOT NULL,
             jpeg BLOB NOT NULL, UNIQUE(book, page)) STRICT;",
        );
        if cache.is_err() {
            tracing::warn!("Preview cache unavailable");
        }
        Self {
            cache: cache.ok(),
            renderer: Mutex::new(()),
        }
    }

    async fn cached(&self, id: &str, page: i32) -> Option<Bytes> {
        let id = id.to_owned();
        self.cache
            .as_ref()?
            .query(move |db| {
                Ok(db
                    .query_row(
                        "SELECT jpeg FROM previews WHERE book=?1 AND page=?2",
                        params![id, page],
                        |row| row.get::<_, Vec<u8>>(0),
                    )
                    .optional()?)
            })
            .await
            .ok()
            .flatten()
            .map(Bytes::from)
    }

    pub(crate) async fn prepare_covers(&self, source: &Arc<Source>, covers: Vec<(String, Book)>) {
        if self.cache.is_none() {
            return;
        }
        for (id, book) in covers {
            if self.cached(&id, 1).await.is_some() {
                continue;
            }
            let source = Arc::clone(source);
            if let Ok(Ok((file, _))) = tokio::task::spawn_blocking(move || source.open(&book)).await
            {
                let _ = self.page(file, id, 1).await;
            }
        }
    }

    pub(crate) async fn page(
        &self,
        file: File,
        id: String,
        page: i32,
    ) -> Result<Bytes, StatusCode> {
        if let Some(cached) = self.cached(&id, page).await {
            return Ok(cached);
        }
        let _permit = self.renderer.lock().await;
        if let Some(cached) = self.cached(&id, page).await {
            return Ok(cached);
        }
        let number = page.to_string();
        let mut command = Command::new("pdftoppm");
        command
            .args([
                "-f",
                &number,
                "-l",
                &number,
                "-singlefile",
                "-scale-to",
                "960",
                "-cropbox",
                "-jpeg",
                "-jpegopt",
                "quality=82",
                if cfg!(unix) { "/dev/stdin" } else { "-" },
            ])
            .stdin(Stdio::from(file))
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        let output = timeout(Duration::from_secs(20), command.output())
            .await
            .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?
            .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
        if !output.status.success() || !output.stdout.starts_with(&[0xff, 0xd8]) {
            return Err(StatusCode::UNPROCESSABLE_ENTITY);
        }
        let jpeg = Bytes::from(output.stdout);
        if let Some(cache) = &self.cache {
            let data = jpeg.clone();
            let saved = cache.query(move |db| {
                let tx = db.transaction()?;
                tx.execute("INSERT OR REPLACE INTO previews(book,page,jpeg) VALUES(?1,?2,?3)",
                    params![id, page, data.as_ref()])?;
                tx.execute("DELETE FROM previews WHERE rowid IN
                    (SELECT id FROM (SELECT rowid AS id, SUM(length(jpeg)) OVER (ORDER BY rowid DESC) AS used
                    FROM previews) WHERE used > ?1)", [CACHE_BYTES])?;
                tx.commit()?;
                Ok(())
            }).await;
            if saved.is_err() {
                tracing::warn!("Preview cache write unavailable");
            }
        }
        Ok(jpeg)
    }
}
