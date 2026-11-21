use std::{
    collections::HashSet,
    fs::File,
    path::{Path, PathBuf},
    process::Stdio,
    sync::Arc,
    time::Duration,
};

use anyhow::Result;
use axum::body::Bytes;
use rusqlite::{OptionalExtension, params};
use sha2::{Digest, Sha256};
use tokio::{
    process::Command,
    sync::{OnceCell, watch},
    time::timeout,
};

use crate::{
    books::{Book, Catalog, Source},
    database::Database,
    search::Matcher,
};

pub(crate) enum Prepared {
    Pages(Bytes),
    PositionsOnly,
}

pub(crate) struct BookText {
    database: Arc<Database>,
    worker: OnceCell<watch::Sender<Arc<Catalog>>>,
    extractor: PathBuf,
    pub(crate) matcher: Matcher,
}

impl BookText {
    pub(crate) fn open(state: &Path, web: &Path) -> Result<Self> {
        let path = state.join("book-text.sqlite3");
        let database = Database::open(
            &path,
            "PRAGMA auto_vacuum=FULL;
             BEGIN;
             CREATE TABLE IF NOT EXISTS prepared_pages(book TEXT PRIMARY KEY, extractor TEXT NOT NULL,
                 positions_only INTEGER NOT NULL, body BLOB);
             DROP TABLE IF EXISTS pages;
             COMMIT;",
        )?;
        Ok(Self {
            database: Arc::new(database),
            worker: OnceCell::new(),
            extractor: web.join("../src/prepare-book-text.mts"),
            matcher: Matcher::new(web.join("../src/find-book-matches.mts"), path, revision()),
        })
    }

    pub(crate) async fn prepare(&self, source: Arc<Source>, catalog: Arc<Catalog>) {
        self.matcher.warm().await;
        let sender = self
            .worker
            .get_or_init(|| async {
                let (sender, queue) = watch::channel(Arc::new(Catalog::Scanning));
                tokio::spawn(prepare_library(
                    Arc::clone(&self.database),
                    source,
                    self.extractor.clone(),
                    queue,
                ));
                sender
            })
            .await;
        sender.send_replace(catalog);
    }

    pub(crate) async fn get(&self, id: String) -> Result<Option<Prepared>> {
        self.database
            .query(move |db| {
                Ok(db.query_row(
                    "SELECT positions_only, CASE WHEN NOT positions_only THEN body END FROM prepared_pages
                     WHERE book=?1 AND extractor=?2 AND body IS NOT NULL",
                    params![id, revision()], |row| {
                        if row.get(0)? { Ok(Prepared::PositionsOnly) }
                        else { Ok(Prepared::Pages(Bytes::from(row.get::<_, Vec<u8>>(1)?))) }
                    }).optional()?)
            })
            .await
    }
}

async fn prepare_library(
    db: Arc<Database>,
    source: Arc<Source>,
    extractor: PathBuf,
    mut queue: watch::Receiver<Arc<Catalog>>,
) {
    while queue.changed().await.is_ok() {
        let catalog = Arc::clone(&queue.borrow_and_update());
        let Catalog::Ready { books, .. } = catalog.as_ref() else {
            continue;
        };
        let Ok(known) = retain_current(&db, Arc::clone(&catalog)).await else {
            tracing::warn!("Book text cache unavailable");
            continue;
        };
        for (id, book) in books {
            if !matches!(queue.has_changed(), Ok(false)) {
                break;
            }
            if !known.contains(id)
                && prepare_book(&db, &source, &extractor, id, book)
                    .await
                    .is_err()
            {
                tracing::warn!("Book text preparation unavailable");
            }
        }
    }
}

async fn prepare_book(
    db: &Database,
    source: &Arc<Source>,
    extractor: &Path,
    id: &str,
    book: &Book,
) -> Result<()> {
    let open = || {
        let source = Arc::clone(source);
        let book = book.clone();
        tokio::task::spawn_blocking(move || source.open(&book))
    };
    let (file, _) = open().await??;
    let (positions_only, body) = extract(extractor, file).await?;
    open().await??;
    let id = id.to_owned();
    db.query(move |db| {
        db.execute(
            "INSERT OR REPLACE INTO prepared_pages(book,extractor,positions_only,body) VALUES(?1,?2,?3,?4)",
            params![id, revision(), positions_only, body],
        )?;
        Ok(())
    })
    .await
}

fn revision() -> &'static str {
    static REVISION: std::sync::LazyLock<String> = std::sync::LazyLock::new(|| {
        let mut hash = Sha256::new();
        hash.update(include_bytes!("../web/src/prepare-book-text.mts"));
        hash.update(include_bytes!("../web/package.json"));
        format!("{:x}", hash.finalize())
    });
    &REVISION
}

async fn retain_current(db: &Database, catalog: Arc<Catalog>) -> Result<HashSet<String>> {
    db.query(move |db| {
        let tx = db.transaction()?;
        tx.execute(
            "DELETE FROM prepared_pages WHERE extractor<>?1",
            [revision()],
        )?;
        let known = tx
            .prepare("SELECT book FROM prepared_pages")?
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        let mut current = HashSet::new();
        if let Catalog::Ready { books, .. } = catalog.as_ref() {
            for id in known {
                if books.contains_key(&id) {
                    current.insert(id);
                } else {
                    tx.execute("DELETE FROM prepared_pages WHERE book=?1", [id])?;
                }
            }
        }
        tx.commit()?;
        Ok(current)
    })
    .await
}

async fn extract(extractor: &Path, file: File) -> Result<(bool, Option<Vec<u8>>)> {
    let mut command = Command::new("node");
    command
        .arg("--max-old-space-size=384")
        .arg(extractor)
        .stdin(Stdio::from(file))
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    let output = timeout(Duration::from_secs(900), command.output()).await??;
    if output.status.code() == Some(2) {
        return Ok((false, None));
    }
    anyhow::ensure!(
        matches!(output.status.code(), Some(0 | 3)) && output.stdout.starts_with(&[0x1f, 0x8b]),
        "Incomplete book text"
    );
    Ok((output.status.code() == Some(3), Some(output.stdout)))
}
