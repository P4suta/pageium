use std::{
    collections::BTreeMap,
    fs::File,
    io,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use cap_std::{
    ambient_authority,
    fs::{Dir, Metadata, ReadDir},
};
use sha2::{Digest, Sha256};

pub(crate) struct Source {
    pub(crate) books: PathBuf,
    pub(crate) smb_mount: Option<PathBuf>,
}

pub(crate) enum Catalog {
    Scanning,
    Ready {
        books: BTreeMap<String, Book>,
        folders: BTreeMap<String, Folder>,
        revision: String,
    },
    Unavailable,
}

impl Catalog {
    pub(crate) fn newest_additions(&self, previous: &Self, limit: usize) -> Vec<(String, Book)> {
        let Self::Ready { books, .. } = self else {
            return Vec::new();
        };
        let mut added: Vec<_> = books.iter().filter(|(id, _)| {
            !matches!(previous, Self::Ready { books: known, .. } if known.contains_key(*id))
        }).collect();
        added.sort_by_key(|(_, book)| std::cmp::Reverse(book.version.modified));
        added
            .into_iter()
            .take(limit)
            .map(|(id, book)| (id.clone(), book.clone()))
            .collect()
    }
}

pub(crate) struct Folder {
    path: PathBuf,
    pub(crate) name: String,
    pub(crate) parent: Option<String>,
    pub(crate) children: Vec<String>,
}

fn scan_entries(
    folder: &Path,
    id: &str,
    entries: ReadDir,
    books: &mut BTreeMap<String, Book>,
) -> io::Result<Vec<PathBuf>> {
    let mut children = Vec::new();
    let display_path = folder.strip_prefix(".").unwrap_or(folder).to_string_lossy();
    for entry in entries {
        let entry = entry?;
        let path = folder.join(entry.file_name());
        let Some(metadata) = present(entry.metadata())? else {
            continue;
        };
        if metadata.is_dir() {
            children.push(path);
        } else if metadata.is_file()
            && path
                .extension()
                .is_some_and(|ext| ext.eq_ignore_ascii_case("pdf"))
            && let Some(name) = path.file_stem()
        {
            let version = FileVersion::read(&metadata)?;
            books.insert(
                version.id(&path),
                Book {
                    version,
                    title: name.to_string_lossy().into_owned(),
                    folder: display_path.to_string(),
                    folder_id: id.to_owned(),
                    path,
                },
            );
        }
    }
    children.sort_unstable();
    Ok(children)
}

#[derive(Clone)]
pub(crate) struct Book {
    path: PathBuf,
    version: FileVersion,
    pub(crate) title: String,
    pub(crate) folder: String,
    pub(crate) folder_id: String,
}

impl Book {
    pub(crate) fn under(&self, folder: &Folder) -> bool {
        self.path.starts_with(&folder.path)
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
struct FileVersion {
    bytes: u64,
    modified: SystemTime,
}

impl FileVersion {
    fn read(info: &Metadata) -> io::Result<Self> {
        Ok(Self {
            bytes: info.len(),
            modified: info.modified()?.into_std(),
        })
    }

    fn id(self, path: &Path) -> String {
        let nanos = match self.modified.duration_since(UNIX_EPOCH) {
            Ok(duration) => duration.as_nanos() as i128,
            Err(error) => -(error.duration().as_nanos() as i128),
        };
        let mut digest = Sha256::new();
        digest.update(self.bytes.to_be_bytes());
        digest.update(nanos.to_be_bytes());
        digest.update(path.as_os_str().as_encoded_bytes());
        format!("{:x}", digest.finalize())
    }
}

impl Source {
    fn root(&self) -> io::Result<Dir> {
        if let Some(mount) = &self.smb_mount {
            require_smb_mount(mount)?;
        }
        Dir::open_ambient_dir(&self.books, ambient_authority())
    }

    pub(crate) fn index(&self) -> io::Result<Catalog> {
        let root = self.root()?;
        let mut books = BTreeMap::new();
        let mut folders = BTreeMap::<String, Folder>::new();
        let mut pending = vec![(PathBuf::from("."), None::<String>)];
        while let Some((path, parent)) = pending.pop() {
            let (id, entries) = if let Some(parent_id) = &parent {
                let Some(entries) = present(root.read_dir(&path))? else {
                    continue;
                };
                let id = format!("{:x}", Sha256::digest(path.as_os_str().as_encoded_bytes()));
                folders
                    .get_mut(parent_id)
                    .ok_or_else(|| io::Error::other("Missing parent in folder index"))?
                    .children
                    .push(id.clone());
                (id, entries)
            } else {
                (String::new(), root.entries()?)
            };
            let children = scan_entries(&path, &id, entries, &mut books)?;
            pending.extend(
                children
                    .into_iter()
                    .rev()
                    .map(|child| (child, Some(id.clone()))),
            );
            folders.insert(
                id,
                Folder {
                    name: path
                        .file_name()
                        .unwrap_or_default()
                        .to_string_lossy()
                        .into_owned(),
                    path,
                    parent,
                    children: Vec::new(),
                },
            );
        }
        let mut digest = Sha256::new();
        for id in folders.keys() {
            digest.update(id.as_bytes());
        }
        digest.update([0]);
        for id in books.keys() {
            digest.update(id.as_bytes());
        }
        Ok(Catalog::Ready {
            books,
            folders,
            revision: format!("{:x}", digest.finalize()),
        })
    }

    pub(crate) fn open(&self, book: &Book) -> io::Result<(File, u64)> {
        let root = self.root()?;
        if !root.symlink_metadata(&book.path)?.is_file() {
            return Err(io::ErrorKind::NotFound.into());
        }
        let file = root.open(&book.path)?;
        let metadata = file.metadata()?;
        if !metadata.is_file() || FileVersion::read(&metadata)? != book.version {
            return Err(io::ErrorKind::NotFound.into());
        }
        Ok((file.into_std(), book.version.bytes))
    }
}

fn present<T>(result: io::Result<T>) -> io::Result<Option<T>> {
    match result {
        Ok(value) => Ok(Some(value)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}

fn require_smb_mount(mount: &Path) -> io::Result<()> {
    if !cfg!(target_os = "linux") {
        return Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "SMB mount checks require Linux",
        ));
    }
    let mounts = std::fs::read_to_string("/proc/self/mountinfo")?;
    if contains_read_only_smb(&mounts, mount) {
        Ok(())
    } else {
        Err(io::Error::new(
            io::ErrorKind::NotConnected,
            "Read-only SMB mount is unavailable",
        ))
    }
}

fn contains_read_only_smb(mounts: &str, mount: &Path) -> bool {
    let encoded = mount
        .to_string_lossy()
        .replace('\\', "\\134")
        .replace(' ', "\\040")
        .replace('\t', "\\011")
        .replace('\n', "\\012");
    mounts
        .lines()
        .filter_map(|line| line.split_once(" - "))
        .any(|(mount, filesystem)| {
            let mut fields = mount.split_ascii_whitespace().skip(4);
            fields.next() == Some(encoded.as_str())
                && fields
                    .next()
                    .is_some_and(|options| options.split(',').any(|option| option == "ro"))
                && matches!(
                    filesystem.split_ascii_whitespace().next(),
                    Some("cifs" | "smb3")
                )
        })
}

#[cfg(test)]
mod tests {
    use std::{io, path::Path};

    use super::{contains_read_only_smb, present};

    #[test]
    fn prepares_recent_additions_and_skips_known_versions() -> io::Result<()> {
        let folder = tempfile::tempdir()?;
        let source = super::Source {
            books: folder.path().into(),
            smb_mount: None,
        };
        std::fs::write(folder.path().join("Known.pdf"), b"existing")?;
        let before = source.index()?;
        for day in 1..=3 {
            let file = std::fs::File::create(folder.path().join(format!("Scan{day}.pdf")))?;
            file.set_modified(
                std::time::UNIX_EPOCH + std::time::Duration::from_secs(day * 86_400),
            )?;
        }
        let after = source.index()?;
        let names: Vec<_> = after
            .newest_additions(&before, 2)
            .into_iter()
            .map(|(_, book)| book.title)
            .collect();
        assert_eq!(names, ["Scan3", "Scan2"]);
        assert!(after.newest_additions(&after, 8).is_empty());
        Ok(())
    }

    #[test]
    fn a_scan_skips_missing_entries_and_propagates_other_errors() -> io::Result<()> {
        assert_eq!(present(Ok(7))?, Some(7));
        assert_eq!(present::<()>(Err(io::ErrorKind::NotFound.into()))?, None);
        assert!(matches!(
            present::<()>(Err(io::ErrorKind::PermissionDenied.into())),
            Err(error) if error.kind() == io::ErrorKind::PermissionDenied
        ));
        Ok(())
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn reports_a_missing_linux_mount_as_disconnected() {
        let result = super::require_smb_mount(Path::new("/pageium-fixture-unmounted"));
        assert!(matches!(result, Err(error) if error.kind() == io::ErrorKind::NotConnected));
    }

    #[test]
    fn recognizes_only_read_only_smb_at_the_configured_mountpoint() {
        let books = Path::new("/mnt/Scan Snap");
        let read_only = "42 28 0:60 / /mnt/Scan\\040Snap ro,relatime - cifs //nas/books ro";
        assert!(contains_read_only_smb(read_only, books));
        assert!(!contains_read_only_smb(
            &read_only.replace("ro,", "rw,"),
            books
        ));
        assert!(!contains_read_only_smb(
            &read_only.replace("cifs", "tmpfs"),
            books
        ));
        assert!(!contains_read_only_smb(read_only, Path::new("/mnt/Scan")));
    }
}
