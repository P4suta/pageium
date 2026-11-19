use std::{net::SocketAddr, path::PathBuf, time::Duration};

use anyhow::{Context, Result, ensure};
use clap::Parser;
use pageium::{Pageium, Paths};

#[derive(Parser)]
#[command(about = "Browse and read scanned PDFs from a mounted library")]
struct Args {
    /// Directory that contains the PDF originals.
    #[arg(long, env = "PAGEIUM_BOOKS")]
    books: PathBuf,

    /// Local directory for the reading position database.
    #[arg(long, env = "PAGEIUM_STATE", default_value = ".local/state")]
    state: PathBuf,

    /// Directory containing the built web application.
    #[arg(long, env = "PAGEIUM_WEB", default_value = "web/dist")]
    web: PathBuf,

    /// Require a read-only Linux SMB mount at the specified path.
    #[arg(long, env = "PAGEIUM_SMB_MOUNT")]
    smb_mount: Option<PathBuf>,

    /// Address to listen on.
    #[arg(long, env = "PAGEIUM_LISTEN", default_value = "127.0.0.1:8787")]
    listen: SocketAddr,
}

#[tokio::main(worker_threads = 2)]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_writer(std::io::stderr)
        .init();
    let args = Args::parse();
    ensure!(
        args.web.join("index.html").is_file(),
        "The built web application is missing. Run just build."
    );
    let app = Pageium::open(Paths {
        books: args.books,
        state: args.state,
        web: args.web,
        smb_mount: args.smb_mount,
    })?;
    let listener = tokio::net::TcpListener::bind(args.listen)
        .await
        .context("Bind Pageium listener")?;
    let scanning = app.clone();
    tokio::spawn(async move {
        loop {
            scanning.refresh().await;
            tokio::time::sleep(Duration::from_secs(30)).await;
        }
    });
    tracing::info!(listen = %listener.local_addr()?, "Pageium listening");
    axum::serve(listener, app.router())
        .with_graceful_shutdown(shutdown())
        .await?;
    Ok(())
}

async fn shutdown() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{SignalKind, signal};
        if let Ok(mut terminate) = signal(SignalKind::terminate()) {
            tokio::select! {
                _ = terminate.recv() => {},
                _ = tokio::signal::ctrl_c() => {},
            }
            return;
        }
    }
    if tokio::signal::ctrl_c().await.is_err() {
        std::future::pending::<()>().await;
    }
}
