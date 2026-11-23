# Container deployment

Pageium reads PDF originals from a mounted folder and stores reading positions in local SQLite.
The server caches page previews on local storage and the browser renders the original PDF at the reading scale.
One reader on a trusted network can resume reading across browsers.

## Mount the books folder

Give a Synology Server Message Block (SMB) account read access to the shared folder containing the books.
Install `cifs-utils` on the Raspberry Pi and create `/srv/pageium/books` as the mount point.
Store the SMB login in a root-readable credentials file with mode `0600`.
Use a library directory such as `books` in the account's home share.
Keep the credentials file on the Pi.

Use [the mount template](../deployment/srv-pageium-books.mount.example) to create `/etc/systemd/system/srv-pageium-books.mount`.
Use the network directory and the rootless app account's numeric user and group IDs.
Install [the automount unit](../deployment/srv-pageium-books.automount) in the same directory.
[Debian mount options](https://manpages.debian.org/trixie/cifs-utils/mount.cifs.8.en.html), [systemd automount](https://manpages.debian.org/trixie/systemd/systemd.automount.5.en.html)

Enable the automount and check the filesystem before starting Pageium.

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now srv-pageium-books.automount
sudo systemctl start srv-pageium-books.mount
findmnt --mountpoint /srv/pageium/books --output TARGET,FSTYPE,VFS-OPTIONS
```

## Start the container

Build the image for ARM64 and tag it `localhost/pageium:local` in the Pi app account's Podman image store.
The image includes the web assets, Poppler, and fallback fonts for Latin and East Asian text.

```sh
podman build --platform linux/arm64 --tag localhost/pageium:local --file Containerfile .
mkdir -p ~/.local/share/pageium/state ~/.config/containers/systemd
install -m 0644 deployment/pageium.container ~/.config/containers/systemd/pageium.container
systemctl --user daemon-reload
systemctl --user start pageium.service
```

The supplied Quadlet publishes `127.0.0.1:8787` on the Pi.
Use a private network reverse proxy or set `PublishPort` to the Pi's trusted interface address for access from an iPad or iPhone.
Set `PAGEIUM_BOOKS` in the Quadlet to the path under `/books` if the PDFs occupy a subfolder of the mount.
User lingering starts the service at boot, and the service retries if the mount is unavailable.
[Podman Quadlet](https://docs.podman.io/en/latest/markdown/podman-systemd.unit.5.html)

```sh
systemctl --user status pageium.service
curl -fsS http://127.0.0.1:8787/healthz
```

Open the library and read a PDF from the share.
Pageium scans the books folder when the service starts.
The library opens at the configured books directory and lists its folders and PDFs.
Create folders on the share and select **Rescan library** after adding, moving, or removing a folder or PDF.
Each scan prepares covers for up to eight of the newest additions while the catalog remains available.
The scan waits up to four seconds for the previews and then lets the remaining conversions finish in the background.
Open a folder to browse its contents, or search by title or folder name within the open folder and its descendants.
Select an ancestor in the folder path to return to it.
Moving or renaming a PDF gives it a different reading-position identifier.
Restart the service after replacing the host mount so the container binds the mounted share.
The state directory holds reading history in `progress.sqlite3` and up to 32 MiB of preview images in `previews.sqlite3`.
Zoom in to eight times the fitted size with a desktop trackpad pinch, the Zoom in button, or the plus key.
The minus key zooms out and the zero key resets the zoom level.
To stop the service while keeping the reading history, run `systemctl --user stop pageium.service`.

## Upgrade and roll back

Keep the running image and one previous image.
When the storage reports `Supports shifting: false` in `podman info`, rootless Podman keeps an ID-mapped copy of each image that ran under `UserNS=keep-id`.
Every retained image then costs its full size again.
Move the previous tag to the running image, build the candidate, and restart the service.

```sh
podman tag localhost/pageium:local localhost/pageium:previous
podman build --platform linux/arm64 --tag localhost/pageium:local --file Containerfile .
systemctl --user restart pageium.service
curl -fsS http://127.0.0.1:8787/healthz
```

Open the library and a PDF.
Then remove the image that lost its last tag.

```sh
podman image prune --force
```

If the candidate fails, restore the previous image and restart the service.

```sh
podman tag localhost/pageium:previous localhost/pageium:local
systemctl --user restart pageium.service
podman image prune --force
```

Keep both tags as the only names for Pageium images, so pruning removes every earlier image.
[Podman image prune](https://docs.podman.io/en/latest/markdown/podman-image-prune.1.html), [Podman tag](https://docs.podman.io/en/latest/markdown/podman-tag.1.html)

## Verify a development build

Install Poppler so the server can run `pdftoppm` when serving previews outside the container.
Run `mise x -- just build` before `mise x -- just check`.
Run `mise x -- just browser` for the headless WebKit tests.
Run `mise x -- just advisories` for the Rust dependency advisory check.
