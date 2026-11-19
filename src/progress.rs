use std::{
    collections::BTreeMap,
    num::NonZeroU32,
    path::Path,
    sync::{Arc, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use anyhow::{Result, anyhow};
use rusqlite::{Connection, OptionalExtension, Row, params};
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Position {
    page: NonZeroU32,
    total: NonZeroU32,
}

impl Position {
    pub(crate) fn valid(self) -> bool {
        self.page <= self.total
    }
}

pub(crate) struct Saved {
    pub(crate) position: Position,
    pub(crate) updated: i64,
}

pub(crate) struct Store(Arc<Mutex<Connection>>);

fn row_position(row: &Row<'_>) -> rusqlite::Result<Position> {
    Ok(Position {
        page: row.get(0)?,
        total: row.get(1)?,
    })
}

impl Store {
    pub(crate) fn open(path: &Path) -> Result<Self> {
        let connection = Connection::open(path)?;
        connection.busy_timeout(Duration::from_secs(3))?;
        connection.execute_batch(
            "CREATE TABLE IF NOT EXISTS progress (
                book TEXT PRIMARY KEY,
                page INTEGER NOT NULL CHECK(page > 0 AND page <= total),
                total INTEGER NOT NULL,
                updated INTEGER NOT NULL
            ) STRICT;",
        )?;
        Ok(Self(Arc::new(Mutex::new(connection))))
    }

    pub(crate) async fn all(&self) -> Result<BTreeMap<String, Saved>> {
        self.query(|connection| {
            let mut select =
                connection.prepare("SELECT page, total, book, updated FROM progress")?;
            let rows = select.query_map([], |row| {
                Ok((
                    row.get(2)?,
                    Saved {
                        position: row_position(row)?,
                        updated: row.get(3)?,
                    },
                ))
            })?;
            Ok(rows.collect::<rusqlite::Result<_>>()?)
        })
        .await
    }

    pub(crate) async fn position(&self, id: String) -> Result<Option<Position>> {
        self.query(move |connection| {
            Ok(connection
                .query_row(
                    "SELECT page, total FROM progress WHERE book = ?1",
                    [id],
                    row_position,
                )
                .optional()?)
        })
        .await
    }

    pub(crate) async fn set(&self, id: String, position: Position) -> Result<()> {
        self.query(move |connection| {
            let updated = i64::try_from(SystemTime::now().duration_since(UNIX_EPOCH)?.as_millis())?;
            connection.execute(
                "INSERT INTO progress (book, page, total, updated) VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT(book) DO UPDATE SET page=excluded.page, total=excluded.total, updated=excluded.updated",
                params![id, position.page.get(), position.total.get(), updated],
            )?;
            Ok(())
        }).await
    }

    async fn query<T: Send + 'static>(
        &self,
        query: impl FnOnce(&Connection) -> Result<T> + Send + 'static,
    ) -> Result<T> {
        let database = Arc::clone(&self.0);
        tokio::task::spawn_blocking(move || {
            let connection = database
                .lock()
                .map_err(|_| anyhow!("Reading position database is unavailable"))?;
            query(&connection)
        })
        .await?
    }
}
