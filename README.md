# T_ClientMap — Personal Projects

Live: https://clientmap.thangaminfotech.com

Private, login-protected app for projects, customers, project sharing over WhatsApp, clinic visits and follow-ups, client route search, and invoices with an A4 letterhead.

## Stack
- **Backend:** FastAPI (Python 3.12) + pymssql → SQL Server `T_Map` on 147.93.155.21. The tables are created automatically at startup.
- **Frontend:** a plain HTML/CSS/JS single-page app in `backend/static` with no build step. It is served by the same container.
- **Server:** Docker container `clientmap-app` on `127.0.0.1:5130`, behind host nginx (`/etc/nginx/sites-available/clientmap.conf`) with the `*.thangaminfotech.com` wildcard cert.
- **Files:** uploads are stored in `/opt/projects/clientmap/data/uploads` on the server. They are only served to their owner, or through 24-hour share links (`/s/<token>`).

## Configuration (`backend/.env`, not committed)
| Key | Purpose |
| --- | --- |
| `DB_*` | SQL Server connection |
| `JWT_SECRET` | Session signing key |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | First account, created only when the Users table is empty |
| `GOOGLE_MAPS_SERVER_KEY` | **Server only.** Enable *Routes API* and *Places API (New)*; restrict the key by server IP 156.67.104.242 |
| `GOOGLE_MAPS_BROWSER_KEY` | Enable only the *Maps JavaScript API*; restrict it by HTTP referrer `https://clientmap.thangaminfotech.com/*` |
| `GOOGLE_MAP_ID` | Map ID for advanced markers (`DEMO_MAP_ID` works) |
| `ROUTE_MAX_PER_DAY` | Per-user cap on paid route searches (default 150) |

## Deploy
```bash
python deploy/deploy.py
```
The script reads SSH details from `deploy/deploy.env`. It backs up the previous release to `/opt/projects/clientmap-backup-<stamp>.tgz` (uploaded files are kept), rebuilds the container, installs the nginx site and reloads nginx after `nginx -t`.

## Users
```bash
docker exec -it clientmap-app python -m app.manage add-user <username> <password> "Full Name"
docker exec -it clientmap-app python -m app.manage set-password <username> <password>
```
Each user sees only their own projects, customers, visits, clinics, packages, invoices and files.
