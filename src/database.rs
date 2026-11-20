use std::{
    path::Path,
    sync::{Arc, Mutex},
    time::Duration,
};

use anyhow::{Result, anyhow};
use rusqlite::Connection;

pub(crate) struct Database(Arc<Mutex<Connection>>);

impl Database {
    pub(crate) fn open(path: &Path, schema: &str) -> Result<Self> {
        let connection = Connection::open(path)?;
        connection.busy_timeout(Duration::from_secs(3))?;
        connection.execute_batch(schema)?;
        Ok(Self(Arc::new(Mutex::new(connection))))
    }

    pub(crate) async fn query<T: Send + 'static>(
        &self,
        query: impl FnOnce(&mut Connection) -> Result<T> + Send + 'static,
    ) -> Result<T> {
        let database = Arc::clone(&self.0);
        tokio::task::spawn_blocking(move || {
            let mut connection = database
                .lock()
                .map_err(|_| anyhow!("Database unavailable"))?;
            query(&mut connection)
        })
        .await?
    }
}
