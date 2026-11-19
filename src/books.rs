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
        revision: String,
    },
    Unavailable,
}

impl Catalog {
    pub(crate) fn ready(books: BTreeMap<String, Book>) -> Self {
        let mut digest = Sha256::new();
        for id in books.keys() {
            digest.update(id.as_bytes());
        }
        Self::Ready {
            books,
            revision: format!("{:x}", digest.finalize()),
        }
    }
}

#[derive(Clone)]
pub(crate) struct Book {
    path: PathBuf,
    version: FileVersion,
    pub(crate) title: String,
    pub(crate) folder: String,
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

    pub(crate) fn index(&self) -> io::Result<BTreeMap<String, Book>> {
        let root = self.root()?;
        let mut books = BTreeMap::new();
        let mut pending = Vec::new();
        scan_folder(Path::new("."), root.entries()?, &mut books, &mut pending)?;
        while let Some(folder) = pending.pop() {
            if let Some(entries) = present(root.read_dir(&folder))? {
                scan_folder(&folder, entries, &mut books, &mut pending)?;
            }
        }
        Ok(books)
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

fn scan_folder(
    folder: &Path,
    entries: ReadDir,
    books: &mut BTreeMap<String, Book>,
    pending: &mut Vec<PathBuf>,
) -> io::Result<()> {
    for entry in entries {
        let entry = entry?;
        let path = folder.join(entry.file_name());
        let Some(metadata) = present(entry.metadata())? else {
            continue;
        };
        if metadata.is_dir() {
            pending.push(path);
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
                    folder: folder
                        .strip_prefix(".")
                        .unwrap_or(folder)
                        .to_string_lossy()
                        .into_owned(),
                    path,
                },
            );
        }
    }
    Ok(())
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
