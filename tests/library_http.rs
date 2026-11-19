use std::{
    fs,
    path::Path,
    time::{Duration, UNIX_EPOCH},
};

use anyhow::{Result, ensure};
use axum::{
    Router,
    body::{Body, Bytes, to_bytes},
    http::{Method, Request, StatusCode, header},
    response::Response,
};
use pageium::{Pageium, Paths};
use serde::Deserialize;
use tempfile::TempDir;
use tower::ServiceExt;

const PDF: &[u8] = b"%PDF-1.7\n0123456789abcdefghijk\n%%EOF\n";

struct Fixture {
    directory: TempDir,
    app: Pageium,
}

impl Fixture {
    fn empty() -> Result<Self> {
        let directory = tempfile::tempdir()?;
        let books = directory.path().join("books");
        fs::create_dir(&books)?;
        let app = Pageium::open(paths(directory.path()))?;
        Ok(Self { directory, app })
    }

    async fn one_book() -> Result<Self> {
        let fixture = Self::empty()?;
        let folder = fixture.directory.path().join("books/scans");
        fs::create_dir(&folder)?;
        fs::write(folder.join("海辺の町.PDF"), PDF)?;
        fs::write(folder.join("notes.txt"), "not a book")?;
        fixture.app.refresh().await;
        Ok(fixture)
    }
}

fn paths(root: &Path) -> Paths {
    Paths {
        books: root.join("books"),
        state: root.join("state"),
        web: root.join("web"),
        smb_mount: None,
    }
}

#[derive(Debug, Deserialize)]
struct LibraryView {
    status: String,
    #[serde(default)]
    books: Vec<BookView>,
}

#[derive(Debug, Deserialize)]
struct BookView {
    id: String,
    title: String,
    progress: Option<ProgressView>,
}

#[derive(Debug, Deserialize)]
struct CatalogPage {
    books: Vec<BookView>,
    revision: String,
    page: usize,
    pages: usize,
    total: usize,
}

#[tokio::test]
async fn keeps_scroll_order_when_the_most_recent_book_changes() -> Result<()> {
    let fixture = Fixture::empty()?;
    let books = fixture.directory.path().join("books");
    fs::write(books.join("Atlas.pdf"), PDF)?;
    fs::write(books.join("Chronicle.pdf"), PDF)?;
    fixture.app.refresh().await;
    let first = request(
        fixture.app.router(),
        Method::GET,
        "/api/library?page=1",
        &[],
        Body::empty(),
    )
    .await?;
    let first: CatalogPage = serde_json::from_slice(&body(first).await?)?;
    let id = &first.books[1].id;
    let position = request(
        fixture.app.router(),
        Method::PUT,
        &format!("/api/books/{id}/progress"),
        &[("content-type", "application/json")],
        Body::from(r#"{"page":3,"total":8}"#),
    )
    .await?;
    assert_eq!(position.status(), StatusCode::NO_CONTENT);
    assert_eq!(shelf(&fixture.app).await?.books[0].id, *id);
    let ongoing = request(
        fixture.app.router(),
        Method::GET,
        "/api/library?page=1&pin=",
        &[],
        Body::empty(),
    )
    .await?;
    let ongoing: CatalogPage = serde_json::from_slice(&body(ongoing).await?)?;
    assert_eq!(ongoing.books[0].id, first.books[0].id);
    assert_eq!(ongoing.revision, first.revision);

    fs::rename(books.join("Atlas.pdf"), books.join("Almanac.pdf"))?;
    fixture.app.refresh().await;
    let changed = request(
        fixture.app.router(),
        Method::GET,
        "/api/library?page=1&pin=",
        &[],
        Body::empty(),
    )
    .await?;
    let changed: CatalogPage = serde_json::from_slice(&body(changed).await?)?;
    assert_eq!(changed.total, first.total);
    assert_ne!(changed.revision, first.revision);
    Ok(())
}

#[derive(Debug, Deserialize)]
struct ProgressView {
    page: u32,
    total: u32,
}

async fn request(
    router: Router,
    method: Method,
    uri: &str,
    headers: &[(&str, &str)],
    body: Body,
) -> Result<Response> {
    let mut builder = Request::builder().method(method).uri(uri);
    for (name, value) in headers {
        builder = builder.header(*name, *value);
    }
    Ok(router.oneshot(builder.body(body)?).await?)
}

async fn body(response: Response) -> Result<Bytes> {
    Ok(to_bytes(response.into_body(), 128 * 1024).await?)
}

async fn shelf(app: &Pageium) -> Result<LibraryView> {
    let response = request(
        app.router(),
        Method::GET,
        "/api/library",
        &[],
        Body::empty(),
    )
    .await?;
    assert_eq!(response.status(), StatusCode::OK);
    Ok(serde_json::from_slice(&body(response).await?)?)
}

#[tokio::test]
async fn pages_and_filters_the_catalog_with_stable_bounds() -> Result<()> {
    let fixture = Fixture::empty()?;
    let books = fixture.directory.path().join("books");
    let collection = books.join("Recorded Walks");
    fs::create_dir(&collection)?;
    for index in 1..=100 {
        fs::write(collection.join(format!("Chronicle {index:03}.pdf")), PDF)?;
    }
    fs::write(books.join("Field Guide.pdf"), PDF)?;
    fixture.app.refresh().await;

    for (query, page, pages, total, count, first) in [
        ("page=1", 1, 3, 101, 48, Some("Chronicle 001")),
        ("page=2", 2, 3, 101, 48, Some("Chronicle 049")),
        ("page=99999", 3, 3, 101, 5, Some("Chronicle 097")),
        (
            "page=1&q=RECORDED+walks",
            1,
            3,
            100,
            48,
            Some("Chronicle 001"),
        ),
        ("page=3&q=chronicle+100", 1, 1, 1, 1, Some("Chronicle 100")),
        ("page=5&q=absent", 1, 1, 0, 0, None),
    ] {
        let response = request(
            fixture.app.router(),
            Method::GET,
            &format!("/api/library?{query}"),
            &[],
            Body::empty(),
        )
        .await?;
        assert_eq!(response.status(), StatusCode::OK, "{query}");
        let result: CatalogPage = serde_json::from_slice(&body(response).await?)?;
        assert_eq!(
            (result.page, result.pages, result.total),
            (page, pages, total),
            "{query}"
        );
        assert_eq!(result.books.len(), count, "{query}");
        assert_eq!(
            result.books.first().map(|book| book.title.as_str()),
            first,
            "{query}"
        );
    }

    let invalid = request(
        fixture.app.router(),
        Method::GET,
        "/api/library?page=0",
        &[],
        Body::empty(),
    )
    .await?;
    assert_eq!(invalid.status(), StatusCode::BAD_REQUEST);
    Ok(())
}

#[tokio::test]
async fn looks_up_a_book_with_its_saved_position() -> Result<()> {
    let fixture = Fixture::one_book().await?;
    let id = &shelf(&fixture.app).await?.books[0].id;
    let url = format!("/api/books/{id}");
    let saved = request(
        fixture.app.router(),
        Method::PUT,
        &format!("{url}/progress"),
        &[("content-type", "application/json")],
        Body::from(r#"{"page":17,"total":32}"#),
    )
    .await?;
    assert_eq!(saved.status(), StatusCode::NO_CONTENT);
    let response = request(fixture.app.router(), Method::GET, &url, &[], Body::empty()).await?;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
    let reply: serde_json::Value = serde_json::from_slice(&body(response).await?)?;
    assert_eq!(reply["status"], "ready");
    assert_eq!(reply["book"]["id"], *id);
    assert_eq!(
        reply["book"]["progress"],
        serde_json::json!({"page":17,"total":32})
    );
    let missing = request(
        fixture.app.router(),
        Method::GET,
        &format!("/api/books/{}", "f".repeat(64)),
        &[],
        Body::empty(),
    )
    .await?;
    assert_eq!(missing.status(), StatusCode::NOT_FOUND);
    Ok(())
}

#[test]
fn rejects_a_library_path_whose_parent_is_a_file() -> Result<()> {
    let directory = tempfile::tempdir()?;
    let file = directory.path().join("not-a-directory");
    fs::write(&file, b"ordinary file")?;
    let mut settings = paths(directory.path());
    settings.books = file.join("books");
    assert!(Pageium::open(settings).is_err());
    assert!(!directory.path().join("state").exists());
    Ok(())
}

#[tokio::test]
async fn book_identifiers_distinguish_paths_and_reject_stale_versions() -> Result<()> {
    let fixture = Fixture::empty()?;
    let source = fixture.directory.path().join("books");
    fs::create_dir(source.join("scans"))?;
    let primary = source.join("Same.pdf");
    let duplicate = source.join("scans/Same.pdf");
    let delta = Duration::from_secs(86400);
    for path in [&primary, &duplicate] {
        fs::write(path, PDF)?;
        fs::File::open(path)?.set_modified(UNIX_EPOCH - delta)?;
    }
    fixture.app.refresh().await;
    let first = shelf(&fixture.app).await?;
    assert_eq!(first.books.len(), 2);
    assert_ne!(first.books[0].id, first.books[1].id);
    assert!(first.books.iter().all(|book| {
        book.id.len() == 64 && book.id.bytes().all(|byte| byte.is_ascii_hexdigit())
    }));
    let original = &first.books[0].id;
    fs::File::open(&primary)?.set_modified(UNIX_EPOCH + delta)?;
    let obsolete = request(
        fixture.app.router(),
        Method::GET,
        &format!("/api/books/{original}/pdf"),
        &[],
        Body::empty(),
    )
    .await?;
    assert_eq!(obsolete.status(), StatusCode::NOT_FOUND);

    fixture.app.refresh().await;
    let updated = shelf(&fixture.app).await?;
    assert_eq!(updated.books.len(), 2);
    assert_ne!(&updated.books[0].id, original);
    assert_eq!(updated.books[1].id, first.books[1].id);
    Ok(())
}

#[tokio::test]
async fn shows_the_most_recent_book_first_and_refuses_unknown_bookmarks() -> Result<()> {
    let fixture = Fixture::empty()?;
    for title in ["Alpha", "Zebra", "beta"] {
        fs::write(
            fixture
                .directory
                .path()
                .join("books")
                .join(format!("{title}.pdf")),
            PDF,
        )?;
    }
    fixture.app.refresh().await;
    let books = shelf(&fixture.app).await?.books;
    assert_eq!(
        books
            .iter()
            .map(|book| book.title.as_str())
            .collect::<Vec<_>>(),
        ["Alpha", "beta", "Zebra"]
    );
    let payload = r#"{"page":8,"total":8}"#;
    let json = [("content-type", "application/json")];
    let saved = request(
        fixture.app.router(),
        Method::PUT,
        &format!("/api/books/{}/progress", books[2].id),
        &json,
        Body::from(payload),
    )
    .await?;
    assert_eq!(saved.status(), StatusCode::NO_CONTENT);
    let books = shelf(&fixture.app).await?.books;
    assert_eq!(
        books
            .iter()
            .map(|book| book.title.as_str())
            .collect::<Vec<_>>(),
        ["Zebra", "Alpha", "beta"]
    );
    let unknown = request(
        fixture.app.router(),
        Method::PUT,
        &format!("/api/books/{}/progress", "f".repeat(64)),
        &json,
        Body::from(payload),
    )
    .await?;
    assert_eq!(unknown.status(), StatusCode::NOT_FOUND);
    Ok(())
}

#[tokio::test]
async fn a_database_failure_does_not_report_success() -> Result<()> {
    let fixture = Fixture::one_book().await?;
    let id = &shelf(&fixture.app).await?.books[0].id;
    let broken =
        rusqlite::Connection::open(fixture.directory.path().join("state/progress.sqlite3"))?;
    broken.execute("DROP TABLE progress", [])?;
    for (method, path, headers, payload) in [
        (
            Method::GET,
            "/api/library".to_owned(),
            &[][..],
            Body::empty(),
        ),
        (
            Method::PUT,
            format!("/api/books/{id}/progress"),
            &[("content-type", "application/json")][..],
            Body::from(r#"{"page":1,"total":2}"#),
        ),
    ] {
        let response = request(fixture.app.router(), method, &path, headers, payload).await?;
        assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
    }
    Ok(())
}

#[tokio::test]
async fn lists_nested_pdf_and_reads_only_the_requested_bytes() -> Result<()> {
    let fixture = Fixture::one_book().await?;
    let library = shelf(&fixture.app).await?;
    assert_eq!(library.status, "ready");
    assert_eq!(library.books.len(), 1);
    let book = &library.books[0];
    assert_eq!(book.title, "海辺の町");
    assert!(book.progress.is_none());
    let uri = format!("/api/books/{}/pdf", book.id);

    let range = request(
        fixture.app.router(),
        Method::GET,
        &uri,
        &[("range", "bytes=5-9")],
        Body::empty(),
    )
    .await?;
    assert_eq!(range.status(), StatusCode::PARTIAL_CONTENT);
    assert_eq!(range.headers()[header::ACCEPT_RANGES], "bytes");
    assert_eq!(
        range.headers()[header::CONTENT_RANGE],
        format!("bytes 5-9/{}", PDF.len())
    );
    assert_eq!(range.headers()[header::CONTENT_LENGTH], "5");
    assert_eq!(range.headers()[header::CONTENT_TYPE], "application/pdf");
    assert_eq!(body(range).await?, &PDF[5..10]);

    let suffix = request(
        fixture.app.router(),
        Method::GET,
        &uri,
        &[("range", "bytes=-6")],
        Body::empty(),
    )
    .await?;
    assert_eq!(suffix.status(), StatusCode::PARTIAL_CONTENT);
    assert_eq!(body(suffix).await?, &PDF[PDF.len() - 6..]);

    let unsatisfiable = request(
        fixture.app.router(),
        Method::GET,
        &uri,
        &[("range", "bytes=1000-")],
        Body::empty(),
    )
    .await?;
    assert_eq!(unsatisfiable.status(), StatusCode::RANGE_NOT_SATISFIABLE);
    assert_eq!(
        unsatisfiable.headers()[header::CONTENT_RANGE],
        format!("bytes */{}", PDF.len())
    );

    let head = request(fixture.app.router(), Method::HEAD, &uri, &[], Body::empty()).await?;
    assert_eq!(head.status(), StatusCode::OK);
    assert_eq!(
        head.headers()[header::CONTENT_LENGTH],
        PDF.len().to_string()
    );
    assert!(body(head).await?.is_empty());
    let full = request(fixture.app.router(), Method::GET, &uri, &[], Body::empty()).await?;
    assert_eq!(full.status(), StatusCode::OK);
    assert_eq!(body(full).await?, PDF);
    assert_eq!(
        fs::read(fixture.directory.path().join("books/scans/海辺の町.PDF"))?,
        PDF
    );
    Ok(())
}

#[tokio::test]
async fn accepts_single_ranges_across_decimal_and_unit_boundaries() -> Result<()> {
    let fixture = Fixture::one_book().await?;
    let shelf = shelf(&fixture.app).await?;
    let uri = format!("/api/books/{}/pdf", shelf.books[0].id);
    for (range, start, end) in [
        ("BYTES=2-3", 2, 4),
        ("bytes=0002-0003", 2, 4),
        ("bytes=0-0", 0, 1),
        ("bytes=5-", 5, PDF.len()),
        ("bytes=5-184467440737095516160", 5, PDF.len()),
        ("bytes=-184467440737095516160", 0, PDF.len()),
        ("bytes=-1", PDF.len() - 1, PDF.len()),
    ] {
        let response = request(
            fixture.app.router(),
            Method::GET,
            &uri,
            &[("range", range), ("accept-encoding", "br, gzip")],
            Body::empty(),
        )
        .await?;
        assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT, "{range}");
        assert_eq!(
            response.headers()[header::CONTENT_RANGE],
            format!("bytes {start}-{}/{}", end - 1, PDF.len())
        );
        assert_eq!(
            response.headers()[header::CONTENT_LENGTH],
            (end - start).to_string()
        );
        assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
        assert!(!response.headers().contains_key(header::CONTENT_ENCODING));
        assert_eq!(body(response).await?, &PDF[start..end]);
    }
    Ok(())
}

#[tokio::test]
async fn refuses_invalid_ranges_and_falls_back_for_unsupported_range_requests() -> Result<()> {
    let fixture = Fixture::one_book().await?;
    let shelf = shelf(&fixture.app).await?;
    let uri = format!("/api/books/{}/pdf", shelf.books[0].id);
    for range in [
        "bytes=2-1",
        "bytes=-",
        "bytes=-0",
        "bytes=+1-2",
        "bytes=1-+2",
        "bytes=1-2-3",
        "bytes=184467440737095516160-",
    ] {
        let response = request(
            fixture.app.router(),
            Method::GET,
            &uri,
            &[("range", range)],
            Body::empty(),
        )
        .await?;
        assert_eq!(
            response.status(),
            StatusCode::RANGE_NOT_SATISFIABLE,
            "{range}"
        );
        assert_eq!(
            response.headers()[header::CONTENT_RANGE],
            format!("bytes */{}", PDF.len())
        );
        assert!(body(response).await?.is_empty());
    }
    for headers in [
        &[("range", "items=0-3")][..],
        &[("range", "bytes=0-3,5-6")][..],
        &[("range", "bytes=0-3"), ("range", "bytes=5-6")][..],
        &[("range", "bytes=0-3"), ("if-range", "\"stale\"")][..],
    ] {
        let response = request(
            fixture.app.router(),
            Method::GET,
            &uri,
            headers,
            Body::empty(),
        )
        .await?;
        assert_eq!(response.status(), StatusCode::OK, "{headers:?}");
        assert_eq!(body(response).await?, PDF);
    }
    Ok(())
}

#[tokio::test]
async fn negotiates_precompressed_assets_and_keeps_html_revalidatable() -> Result<()> {
    let fixture = Fixture::empty()?;
    let web = fixture.directory.path().join("web");
    fs::create_dir_all(web.join("assets"))?;
    fs::write(web.join("index.html"), "Pageium")?;
    fs::write(web.join("assets/shelf-abc.js"), "source")?;
    fs::write(web.join("assets/shelf-abc.js.br"), "compressed")?;
    let router = fixture.app.router();
    let response = request(
        router.clone(),
        Method::GET,
        "/assets/shelf-abc.js",
        &[("accept-encoding", "br")],
        Body::empty(),
    )
    .await?;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()[header::CONTENT_ENCODING], "br");
    assert_eq!(response.headers()[header::VARY], "accept-encoding");
    assert_eq!(
        response.headers()[header::CACHE_CONTROL],
        "public, max-age=31536000, immutable"
    );
    assert_eq!(body(response).await?, "compressed");

    let source = request(
        router.clone(),
        Method::GET,
        "/assets/shelf-abc.js",
        &[],
        Body::empty(),
    )
    .await?;
    assert!(!source.headers().contains_key(header::CONTENT_ENCODING));
    assert_eq!(source.headers()[header::VARY], "accept-encoding");
    assert_eq!(body(source).await?, "source");

    let page = request(router.clone(), Method::GET, "/", &[], Body::empty()).await?;
    assert_eq!(page.headers()[header::CACHE_CONTROL], "no-cache");
    assert_eq!(body(page).await?, "Pageium");
    let missing = request(
        router,
        Method::GET,
        "/assets/missing.js",
        &[],
        Body::empty(),
    )
    .await?;
    assert_eq!(missing.status(), StatusCode::NOT_FOUND);
    assert_ne!(
        missing
            .headers()
            .get(header::CACHE_CONTROL)
            .and_then(|value| value.to_str().ok()),
        Some("public, max-age=31536000, immutable")
    );
    Ok(())
}

#[tokio::test]
async fn saves_progress_and_restores_it_after_reopening() -> Result<()> {
    let fixture = Fixture::one_book().await?;
    let library = shelf(&fixture.app).await?;
    let book = &library.books[0];
    let uri = format!("/api/books/{}/progress", book.id);
    let headers = [("content-type", "application/json")];
    let saved = request(
        fixture.app.router(),
        Method::PUT,
        &uri,
        &headers,
        Body::from(r#"{"page":8,"total":20}"#),
    )
    .await?;
    assert_eq!(saved.status(), StatusCode::NO_CONTENT);
    let refused = request(
        fixture.app.router(),
        Method::PUT,
        &uri,
        &headers,
        Body::from(r#"{"page":21,"total":20}"#),
    )
    .await?;
    assert_eq!(refused.status(), StatusCode::UNPROCESSABLE_ENTITY);
    drop(fixture.app);

    let restarted = Pageium::open(paths(fixture.directory.path()))?;
    restarted.refresh().await;
    let library = shelf(&restarted).await?;
    let Some(progress) = &library.books[0].progress else {
        anyhow::bail!("Missing saved progress");
    };
    assert_eq!((progress.page, progress.total), (8, 20));
    Ok(())
}

#[tokio::test]
async fn reports_unavailable_and_recovers_to_an_empty_shelf() -> Result<()> {
    let fixture = Fixture::empty()?;
    assert_eq!(shelf(&fixture.app).await?.status, "scanning");
    let books = fixture.directory.path().join("books");
    fs::remove_dir(&books)?;
    fixture.app.refresh().await;
    assert_eq!(shelf(&fixture.app).await?.status, "unavailable");
    fs::create_dir(&books)?;
    fixture.app.refresh().await;
    let library = shelf(&fixture.app).await?;
    assert_eq!(library.status, "ready");
    assert!(library.books.is_empty());
    Ok(())
}

#[tokio::test]
async fn requires_the_configured_smb_mount_to_be_mounted() -> Result<()> {
    let fixture = Fixture::empty()?;
    let mut config = paths(fixture.directory.path());
    config.smb_mount = Some(config.books.clone());
    let app = Pageium::open(config)?;
    app.refresh().await;
    assert_eq!(shelf(&app).await?.status, "unavailable");
    Ok(())
}

#[cfg(unix)]
#[tokio::test]
async fn rejects_a_pdf_replaced_with_a_link_after_scanning() -> Result<()> {
    let fixture = Fixture::one_book().await?;
    let library = shelf(&fixture.app).await?;
    let first_id = &library.books[0].id;
    let outside = fixture.directory.path().join("outside.pdf");
    fs::write(&outside, PDF)?;
    let scanned = fixture.directory.path().join("books/scans/海辺の町.PDF");
    fs::remove_file(&scanned)?;
    std::os::unix::fs::symlink(&outside, &scanned)?;
    let uri = format!("/api/books/{first_id}/pdf");
    let response = request(fixture.app.router(), Method::GET, &uri, &[], Body::empty()).await?;
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    fixture.app.refresh().await;
    ensure!(shelf(&fixture.app).await?.books.is_empty());
    Ok(())
}
