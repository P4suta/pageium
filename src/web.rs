use std::{
    collections::{BTreeMap, HashMap},
    io,
    num::NonZeroUsize,
    path::Path,
    sync::Arc,
};

use axum::{
    Json, Router,
    body::Body,
    extract::{DefaultBodyLimit, Path as RoutePath, Query, State},
    http::{HeaderMap, HeaderValue, Method, StatusCode, header},
    middleware::map_response,
    response::{IntoResponse, Response},
    routing::{get, post, put},
};
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncReadExt, AsyncSeekExt};
use tokio_util::io::ReaderStream;
use tower_http::{services::ServeDir, set_header::SetResponseHeaderLayer};

use crate::{
    ScanOutcome, Service,
    books::{Book, Catalog, Folder},
    progress::Position,
    range::{RequestRange, Span},
};

pub(crate) fn router(service: Arc<Service>, web: &Path) -> Router {
    let assets = Router::new()
        .fallback_service(ServeDir::new(web.join("assets")).precompressed_br())
        .layer(map_response(cache_assets));
    let files = Router::new().fallback_service(ServeDir::new(web)).layer(
        SetResponseHeaderLayer::overriding(
            header::CACHE_CONTROL,
            HeaderValue::from_static("no-cache"),
        ),
    );
    Router::new()
        .route("/healthz", get(|| async { StatusCode::NO_CONTENT }))
        .route("/api/library", get(library))
        .route("/api/library/scan", post(scan_library))
        .route("/api/books/{id}", get(book))
        .route("/api/books/{id}/pdf", get(pdf).head(pdf))
        .route("/api/books/{id}/text", get(book_text))
        .route("/api/books/{id}/matches", post(book_matches))
        .route("/api/books/{id}/preview/{page}", get(preview))
        .route("/api/books/{id}/progress", put(save_position))
        .layer(DefaultBodyLimit::max(1024))
        .layer(SetResponseHeaderLayer::if_not_present(
            header::CACHE_CONTROL,
            HeaderValue::from_static("no-store"),
        ))
        .nest("/assets", assets)
        .fallback_service(files)
        .with_state(service)
        .layer(SetResponseHeaderLayer::if_not_present(
            header::X_CONTENT_TYPE_OPTIONS,
            HeaderValue::from_static("nosniff"),
        ))
}

async fn cache_assets(mut response: Response) -> Response {
    let cache = if response.status().is_success() || response.status() == StatusCode::NOT_MODIFIED {
        "public, max-age=31536000, immutable"
    } else {
        "no-cache"
    };
    let headers = response.headers_mut();
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static(cache));
    headers.append(header::VARY, HeaderValue::from_static("accept-encoding"));
    response
}

#[derive(Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
enum CatalogView<'a> {
    Scanning,
    Ready {
        books: Vec<BookView<'a>>,
        recent: Option<&'a str>,
        revision: &'a str,
        #[serde(skip_serializing_if = "Option::is_none")]
        directory: Option<DirectoryView<'a>>,
        #[serde(flatten)]
        pagination: Option<Pagination>,
    },
    Unavailable,
}

#[derive(Serialize)]
struct BookView<'a> {
    id: &'a str,
    title: &'a str,
    folder: &'a str,
    folder_id: &'a str,
    progress: Option<Position>,
    duplicate_title: bool,
}

impl<'a> BookView<'a> {
    fn of(id: &'a str, book: &'a Book, progress: Option<Position>, duplicate_title: bool) -> Self {
        Self {
            id,
            title: &book.title,
            folder: &book.folder,
            folder_id: &book.folder_id,
            progress,
            duplicate_title,
        }
    }
}

#[derive(Deserialize)]
struct LibraryQuery {
    page: Option<NonZeroUsize>,
    q: Option<String>,
    pin: Option<String>,
    folder: Option<String>,
}

#[derive(Serialize)]
struct FolderLink<'a> {
    id: &'a str,
    name: &'a str,
}

#[derive(Serialize)]
struct DirectoryView<'a> {
    path: Vec<FolderLink<'a>>,
    folders: Vec<FolderLink<'a>>,
    total_folders: usize,
    resume: Option<Box<BookView<'a>>>,
}

fn folder_path<'a>(folders: &'a BTreeMap<String, Folder>, mut id: &'a str) -> Vec<FolderLink<'a>> {
    let mut path = Vec::new();
    while let Some(folder) = folders.get(id)
        && let Some(parent) = &folder.parent
    {
        path.push(FolderLink {
            id,
            name: &folder.name,
        });
        id = parent;
    }
    path.reverse();
    path
}

const ENTRIES_PER_PAGE: usize = 48;

#[derive(Serialize)]
struct Pagination {
    page: usize,
    pages: usize,
    total: usize,
}

impl Pagination {
    fn new(requested: NonZeroUsize, books: usize, folders: usize) -> Self {
        let pages = (books + folders).div_ceil(ENTRIES_PER_PAGE).max(1);
        Self {
            page: requested.get().min(pages),
            pages,
            total: books,
        }
    }

    fn offset(&self) -> usize {
        (self.page - 1) * ENTRIES_PER_PAGE
    }
}

async fn library(
    State(service): State<Arc<Service>>,
    Query(filter): Query<LibraryQuery>,
) -> Result<Response, StatusCode> {
    let catalog = Arc::clone(&*service.catalog.read().await);
    let response = match catalog.as_ref() {
        Catalog::Scanning => CatalogView::Scanning,
        Catalog::Ready {
            books: entries,
            folders,
            revision,
        } => {
            let location = filter
                .folder
                .as_deref()
                .map(|id| folders.get_key_value(id).ok_or(StatusCode::NOT_FOUND))
                .transpose()?;
            let saved = service.progress.all().await.map_err(progress_error)?;
            let recent = entries
                .keys()
                .filter_map(|id| saved.get(id).map(|item| (id.as_str(), item.updated)))
                .max_by_key(|(_, updated)| *updated)
                .map(|(id, _)| id);
            let pin = filter.pin.as_deref().or(recent);
            let mut title_counts = HashMap::new();
            for book in entries.values() {
                *title_counts.entry(book.title.as_str()).or_insert(0usize) += 1;
            }
            let query = filter
                .q
                .as_deref()
                .unwrap_or_default()
                .trim()
                .to_lowercase();
            let mut ordered: Vec<_> = entries
                .iter()
                .filter(|(_, book)| match location {
                    Some((id, _)) if query.is_empty() => &book.folder_id == id,
                    Some((_, folder)) => book.under(folder),
                    None => true,
                })
                .filter_map(|(id, book)| {
                    let title = book.title.to_lowercase();
                    (query.is_empty()
                        || title.contains(&query)
                        || book.folder.to_lowercase().contains(&query))
                    .then_some((id, book, (Some(id.as_str()) != pin, title)))
                })
                .collect();
            ordered.sort_by(|(id, book, key), (other_id, other, other_key)| {
                (key, &book.folder, id).cmp(&(other_key, &other.folder, other_id))
            });
            let children = location
                .filter(|_| query.is_empty())
                .map_or(&[][..], |(_, folder)| folder.children.as_slice());
            let pagination = filter
                .page
                .map(|requested| Pagination::new(requested, ordered.len(), children.len()));
            let (offset, limit) = pagination
                .as_ref()
                .map_or((0, ordered.len() + children.len()), |page| {
                    (page.offset(), ENTRIES_PER_PAGE)
                });
            let visible_folders = children.iter().skip(offset).take(limit);
            let book_limit = limit - visible_folders.len();
            CatalogView::Ready {
                recent,
                revision,
                directory: location.map(|(id, _)| DirectoryView {
                    path: folder_path(folders, id),
                    folders: visible_folders
                        .map(|id| FolderLink {
                            id,
                            name: &folders[id].name,
                        })
                        .collect(),
                    total_folders: children.len(),
                    resume: recent.and_then(|recent_id| {
                        let book = &entries[recent_id];
                        (id.is_empty()
                            && query.is_empty()
                            && !book.folder_id.is_empty()
                            && offset == 0)
                            .then(|| {
                                Box::new(BookView::of(
                                    recent_id,
                                    book,
                                    Some(saved[recent_id].position),
                                    false,
                                ))
                            })
                    }),
                }),
                pagination,
                books: ordered
                    .into_iter()
                    .skip(offset.saturating_sub(children.len()))
                    .take(book_limit)
                    .map(|(id, book, _)| {
                        BookView::of(
                            id,
                            book,
                            saved.get(id).map(|item| item.position),
                            title_counts[book.title.as_str()] > 1,
                        )
                    })
                    .collect(),
            }
        }
        Catalog::Unavailable => CatalogView::Unavailable,
    };
    Ok(Json(response).into_response())
}

async fn scan_library(State(service): State<Arc<Service>>, Json(()): Json<()>) -> StatusCode {
    match service.refresh().await {
        ScanOutcome::Ready => StatusCode::NO_CONTENT,
        ScanOutcome::Unavailable => StatusCode::SERVICE_UNAVAILABLE,
    }
}

#[derive(Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
enum BookLookup<'a> {
    Scanning,
    Ready { book: BookView<'a> },
    Unavailable,
}

async fn book(
    State(service): State<Arc<Service>>,
    RoutePath(id): RoutePath<String>,
) -> Result<Response, StatusCode> {
    let catalog = Arc::clone(&*service.catalog.read().await);
    let reply = match catalog.as_ref() {
        Catalog::Scanning => BookLookup::Scanning,
        Catalog::Ready { books: entries, .. } => {
            let (key, entry) = entries.get_key_value(&id).ok_or(StatusCode::NOT_FOUND)?;
            let position = service
                .progress
                .position(id)
                .await
                .map_err(progress_error)?;
            BookLookup::Ready {
                book: BookView::of(key, entry, position, false),
            }
        }
        Catalog::Unavailable => BookLookup::Unavailable,
    };
    Ok(Json(reply).into_response())
}

fn progress_error(_error: anyhow::Error) -> StatusCode {
    tracing::error!("Reading position database operation failed");
    StatusCode::INTERNAL_SERVER_ERROR
}

async fn save_position(
    State(service): State<Arc<Service>>,
    RoutePath(id): RoutePath<String>,
    Json(position): Json<Position>,
) -> Result<StatusCode, StatusCode> {
    if !position.valid() {
        return Err(StatusCode::UNPROCESSABLE_ENTITY);
    }
    match service.catalog.read().await.as_ref() {
        Catalog::Ready { books, .. } if books.contains_key(&id) => {}
        Catalog::Ready { .. } => return Err(StatusCode::NOT_FOUND),
        Catalog::Scanning | Catalog::Unavailable => return Err(StatusCode::SERVICE_UNAVAILABLE),
    }
    service
        .progress
        .set(id, position)
        .await
        .map_err(progress_error)?;
    Ok(StatusCode::NO_CONTENT)
}

enum Selection {
    Entire,
    Partial(Span),
    Unsatisfiable,
}

fn select_range(headers: &HeaderMap, size: u64) -> Selection {
    let mut ranges = headers.get_all(header::RANGE).iter();
    let Some(value) = ranges.next() else {
        return Selection::Entire;
    };
    if ranges.next().is_some() || headers.contains_key(header::IF_RANGE) {
        return Selection::Entire;
    }
    let Ok(value) = value.to_str() else {
        return Selection::Unsatisfiable;
    };
    let Some((unit, range)) = value.split_once('=') else {
        return Selection::Unsatisfiable;
    };
    if !unit.eq_ignore_ascii_case("bytes") || range.contains(',') {
        return Selection::Entire;
    }
    RequestRange::parse(range)
        .and_then(|requested| requested.resolve(size))
        .map_or(Selection::Unsatisfiable, Selection::Partial)
}

async fn open_pdf(service: &Service, id: &str) -> Result<(std::fs::File, u64), StatusCode> {
    let book = match service.catalog.read().await.as_ref() {
        Catalog::Ready { books, .. } => books.get(id).cloned().ok_or(StatusCode::NOT_FOUND)?,
        Catalog::Scanning | Catalog::Unavailable => return Err(StatusCode::SERVICE_UNAVAILABLE),
    };
    let source = Arc::clone(&service.source);
    tokio::task::spawn_blocking(move || source.open(&book))
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .map_err(|error| {
            if error.kind() == io::ErrorKind::NotFound {
                StatusCode::NOT_FOUND
            } else {
                tracing::warn!(kind = ?error.kind(), "PDF open unavailable");
                StatusCode::SERVICE_UNAVAILABLE
            }
        })
}

async fn book_text(
    State(service): State<Arc<Service>>,
    RoutePath(id): RoutePath<String>,
) -> Result<Response, StatusCode> {
    open_pdf(&service, &id).await?;
    let text = service
        .book_text
        .as_ref()
        .ok_or(StatusCode::SERVICE_UNAVAILABLE)?;
    let prepared = text
        .get(id)
        .await
        .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?
        .ok_or(StatusCode::NOT_FOUND)?;
    Ok(match prepared {
        crate::book_text::Prepared::Pages(bytes) => {
            ([(header::CONTENT_TYPE, "application/gzip")], bytes).into_response()
        }
        crate::book_text::Prepared::PositionsOnly => StatusCode::NO_CONTENT.into_response(),
    })
}

#[derive(Deserialize)]
struct FindQuery {
    query: String,
}

async fn book_matches(
    State(service): State<Arc<Service>>,
    RoutePath(id): RoutePath<String>,
    Json(request): Json<FindQuery>,
) -> Result<Response, StatusCode> {
    if request.query.is_empty() {
        return Err(StatusCode::BAD_REQUEST);
    }
    open_pdf(&service, &id).await?;
    let text = service
        .book_text
        .as_ref()
        .ok_or(StatusCode::SERVICE_UNAVAILABLE)?;
    let matches = text
        .matcher
        .find(&id, &request.query)
        .await
        .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?
        .ok_or(StatusCode::NOT_FOUND)?;
    Ok(Json(matches).into_response())
}

async fn preview(
    State(service): State<Arc<Service>>,
    RoutePath((id, page)): RoutePath<(String, i32)>,
) -> Result<Response, StatusCode> {
    if page < 1 {
        return Err(StatusCode::BAD_REQUEST);
    }
    let (file, _) = open_pdf(&service, &id).await?;
    let jpeg = service.previews.page(file, id, page).await?;
    Ok((
        [
            (header::CONTENT_TYPE, "image/jpeg"),
            (header::CACHE_CONTROL, "private, max-age=604800, immutable"),
            (
                header::HeaderName::from_static("cross-origin-resource-policy"),
                "same-origin",
            ),
        ],
        jpeg,
    )
        .into_response())
}

async fn pdf(
    State(service): State<Arc<Service>>,
    RoutePath(id): RoutePath<String>,
    method: Method,
    headers: HeaderMap,
) -> Result<Response, StatusCode> {
    let (file, size) = open_pdf(&service, &id).await?;
    let response = Response::builder()
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::CONTENT_TYPE, "application/pdf")
        .header(header::CONTENT_DISPOSITION, "inline")
        .header("Cross-Origin-Resource-Policy", "same-origin");
    let selection = if method == Method::HEAD {
        Selection::Entire
    } else {
        select_range(&headers, size)
    };
    let (response, offset, len) = match selection {
        Selection::Entire => (response, None, size),
        Selection::Partial(span) => (
            response.status(StatusCode::PARTIAL_CONTENT).header(
                header::CONTENT_RANGE,
                format!("bytes {}-{}/{size}", span.start(), span.last()),
            ),
            Some(span.start()),
            span.length(),
        ),
        Selection::Unsatisfiable => {
            return response
                .status(StatusCode::RANGE_NOT_SATISFIABLE)
                .header(header::CONTENT_RANGE, format!("bytes */{size}"))
                .body(Body::empty())
                .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR);
        }
    };
    let body = if method == Method::HEAD {
        Body::empty()
    } else {
        let mut file = tokio::fs::File::from_std(file);
        if let Some(start) = offset {
            file.seek(io::SeekFrom::Start(start))
                .await
                .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
        }
        Body::from_stream(ReaderStream::with_capacity(file.take(len), 64 * 1024))
    };
    response
        .header(header::CONTENT_LENGTH, len)
        .body(body)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}
