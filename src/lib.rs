mod books;
mod database;
mod previews;
mod progress;
mod range;
mod web;

use std::{
    fs, io,
    path::{Path, PathBuf},
    sync::Arc,
};

use anyhow::{Context, Result, ensure};
use axum::Router;
use tokio::sync::{Mutex, RwLock, broadcast};

use books::{Book, Catalog, Source};
use progress::Store;

pub struct Paths {
    pub books: PathBuf,
    pub state: PathBuf,
    pub web: PathBuf,
    pub smb_mount: Option<PathBuf>,
}

#[derive(Clone)]
pub struct Pageium {
    state: Arc<Service>,
    web: PathBuf,
}

struct Service {
    source: Arc<Source>,
    catalog: RwLock<Arc<Catalog>>,
    scan: Mutex<Option<broadcast::Sender<ScanOutcome>>>,
    progress: Store,
    previews: previews::Previews,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ScanOutcome {
    Ready,
    Unavailable,
}

impl Pageium {
    pub fn open(paths: Paths) -> Result<Self> {
        let books = resolve_path(&std::path::absolute(paths.books)?)?;
        let state = resolve_path(&std::path::absolute(paths.state)?)?;
        let smb_mount = paths
            .smb_mount
            .map(|path| resolve_path(&std::path::absolute(path)?))
            .transpose()?;
        ensure!(
            !state.starts_with(&books),
            "State must be outside the books directory"
        );
        if let Some(mount) = &smb_mount {
            ensure!(
                books.starts_with(mount),
                "Books must be within the SMB mount"
            );
            ensure!(
                !state.starts_with(mount),
                "State must be outside the SMB mount"
            );
        }
        fs::create_dir_all(&state).context("Create state directory")?;
        let progress = Store::open(&state.join("progress.sqlite3"))
            .context("Open reading position database")?;
        Ok(Self {
            state: Arc::new(Service {
                source: Arc::new(Source { books, smb_mount }),
                catalog: RwLock::new(Arc::new(Catalog::Scanning)),
                scan: Mutex::new(None),
                progress,
                previews: previews::Previews::open(&state),
            }),
            web: paths.web,
        })
    }

    pub async fn refresh(&self) {
        self.state.refresh().await;
    }

    pub fn router(&self) -> Router {
        web::router(Arc::clone(&self.state), &self.web)
    }
}

impl Service {
    async fn refresh(self: &Arc<Self>) -> ScanOutcome {
        self.start_scan()
            .await
            .recv()
            .await
            .unwrap_or(ScanOutcome::Unavailable)
    }

    async fn start_scan(self: &Arc<Self>) -> broadcast::Receiver<ScanOutcome> {
        let mut active = self.scan.lock().await;
        if let Some(finished) = active.as_ref() {
            return finished.subscribe();
        }
        let (finished, receiver) = broadcast::channel(1);
        *active = Some(finished.clone());
        let service = Arc::clone(self);
        tokio::spawn(async move {
            let (outcome, covers) = service.scan_catalog().await;
            *service.scan.lock().await = None;
            if !covers.is_empty() {
                let warm = tokio::spawn(async move {
                    service
                        .previews
                        .prepare_covers(&service.source, covers)
                        .await;
                });
                let _ = tokio::time::timeout(std::time::Duration::from_secs(4), warm).await;
            }
            let _ = finished.send(outcome);
        });
        receiver
    }

    async fn scan_catalog(&self) -> (ScanOutcome, Vec<(String, Book)>) {
        let source = Arc::clone(&self.source);
        let catalog = match tokio::task::spawn_blocking(move || source.index()).await {
            Ok(Ok(catalog)) => catalog,
            Ok(Err(error)) => {
                tracing::warn!(kind = ?error.kind(), "Library scan unavailable");
                Catalog::Unavailable
            }
            Err(error) => {
                tracing::error!(cancelled = error.is_cancelled(), "Library scan stopped");
                Catalog::Unavailable
            }
        };
        let mut current = self.catalog.write().await;
        if matches!(catalog, Catalog::Ready { .. }) {
            let catalog = Arc::new(catalog);
            let previous = std::mem::replace(&mut *current, Arc::clone(&catalog));
            drop(current);
            (ScanOutcome::Ready, catalog.newest_additions(&previous, 8))
        } else {
            if !matches!(current.as_ref(), Catalog::Ready { .. }) {
                *current = Arc::new(catalog);
            }
            (ScanOutcome::Unavailable, Vec::new())
        }
    }
}

fn resolve_path(path: &Path) -> io::Result<PathBuf> {
    match path.canonicalize() {
        Ok(resolved) => Ok(resolved),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            let Some((parent, name)) = path.parent().zip(path.file_name()) else {
                return Err(error);
            };
            Ok(resolve_path(parent)?.join(name))
        }
        Err(error) => Err(error),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn shares_an_active_scan_after_the_first_request_disconnects() -> Result<()> {
        let root = tempfile::tempdir()?;
        let books = root.path().join("books");
        fs::create_dir(&books)?;
        let app = Pageium::open(Paths {
            books,
            state: root.path().join("state"),
            web: root.path().join("web"),
            smb_mount: None,
        })?;

        let first = app.state.start_scan().await;
        let mut joined = app.state.start_scan().await;
        assert!(first.same_channel(&joined));
        drop(first);
        assert_eq!(joined.recv().await?, ScanOutcome::Ready);
        assert!(matches!(
            app.state.catalog.read().await.as_ref(),
            Catalog::Ready { .. }
        ));

        let mut next = app.state.start_scan().await;
        assert!(!next.same_channel(&joined));
        assert_eq!(next.recv().await?, ScanOutcome::Ready);
        Ok(())
    }
}
