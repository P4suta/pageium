mod books;
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
use tokio::sync::{Mutex, RwLock};

use books::{Catalog, Source};
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
    scan: Mutex<()>,
    progress: Store,
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
                scan: Mutex::new(()),
                progress,
            }),
            web: paths.web,
        })
    }

    pub async fn refresh(&self) {
        let _scan = self.state.scan.lock().await;
        let source = Arc::clone(&self.state.source);
        let catalog = match tokio::task::spawn_blocking(move || source.index()).await {
            Ok(Ok(books)) => Catalog::ready(books),
            Ok(Err(error)) => {
                tracing::warn!(kind = ?error.kind(), "Library scan unavailable");
                Catalog::Unavailable
            }
            Err(error) => {
                tracing::error!(cancelled = error.is_cancelled(), "Library scan stopped");
                Catalog::Unavailable
            }
        };
        *self.state.catalog.write().await = Arc::new(catalog);
    }

    pub fn router(&self) -> Router {
        web::router(Arc::clone(&self.state), &self.web)
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
