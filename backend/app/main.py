"""T_ClientMap / ClientMap - Personal Projects backend (FastAPI)."""
import datetime as dt
import math
import mimetypes
import os
import re
import secrets
import time
import uuid
from collections import defaultdict, deque
from decimal import ROUND_HALF_UP, Decimal
from pathlib import Path
from typing import List, Optional
from urllib.parse import quote
from zoneinfo import ZoneInfo

import bcrypt
import httpx
import jwt
from fastapi import Depends, FastAPI, File, Form, HTTPException, Request, Response, UploadFile
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import db
from .geo import Route, decode_polyline

IST = ZoneInfo("Asia/Kolkata")
BASE_DIR = Path(__file__).resolve().parent.parent
STATIC_DIR = BASE_DIR / "static"
DATA_DIR = Path(os.environ.get("DATA_DIR", BASE_DIR / "data"))
UPLOAD_DIR = DATA_DIR / "uploads"
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)

JWT_SECRET = os.environ.get("JWT_SECRET") or secrets.token_hex(32)
COOKIE = "cm_session"
SESSION_DAYS = 30
PUBLIC_BASE_URL = os.environ.get("PUBLIC_BASE_URL", "").rstrip("/")
SENDER_MOBILE = os.environ.get("SENDER_MOBILE", "9843998950")
MAPS_SERVER_KEY = os.environ.get("GOOGLE_MAPS_SERVER_KEY", "")
MAPS_BROWSER_KEY = os.environ.get("GOOGLE_MAPS_BROWSER_KEY", "")
MAX_UPLOAD = 25 * 1024 * 1024
SHARE_HOURS = 24
DEFAULT_PACKAGES = ["Clinic", "Pharmacy", "Lab", "Patient Portal", "Vendor Portal"]
BILLING_TYPES = ["One time", "Monthly", "Quarterly", "Half-yearly", "Yearly"]

app = FastAPI(title="ClientMap", docs_url=None, redoc_url=None, openapi_url=None)


@app.on_event("startup")
def startup():
    db.init_schema()
    u, p = os.environ.get("ADMIN_USERNAME"), os.environ.get("ADMIN_PASSWORD")
    if u and p and not db.query("SELECT TOP 1 Id FROM Users", one=True):
        db.execute(
            "INSERT INTO Users(Username,PasswordHash,FullName) VALUES(%s,%s,%s)",
            (u, bcrypt.hashpw(p.encode(), bcrypt.gensalt()).decode(), "Administrator"),
        )


@app.middleware("http")
async def security_headers(request: Request, call_next):
    resp = await call_next(request)
    resp.headers.setdefault("X-Content-Type-Options", "nosniff")
    resp.headers.setdefault("Referrer-Policy", "same-origin")
    resp.headers.setdefault("X-Frame-Options", "SAMEORIGIN")
    if request.url.path.startswith("/api/"):
        resp.headers.setdefault("Cache-Control", "no-store")
    return resp


# ---------------------------------------------------------------- auth
_fails: dict = defaultdict(deque)


def today_ist() -> dt.date:
    return dt.datetime.now(IST).date()


def current_user(request: Request) -> int:
    tok = request.cookies.get(COOKIE)
    if not tok:
        raise HTTPException(401, "Not signed in")
    try:
        data = jwt.decode(tok, JWT_SECRET, algorithms=["HS256"])
    except jwt.PyJWTError:
        raise HTTPException(401, "Session expired")
    return int(data["sub"])


class LoginIn(BaseModel):
    username: str
    password: str


@app.post("/api/auth/login")
def login(body: LoginIn, request: Request, response: Response):
    ip = request.headers.get("x-real-ip") or (request.client.host if request.client else "?")
    q = _fails[ip]
    now = time.time()
    while q and now - q[0] > 900:
        q.popleft()
    if len(q) >= 10:
        raise HTTPException(429, "Too many attempts. Try again in a few minutes.")
    u = db.query("SELECT Id,Username,PasswordHash,FullName FROM Users WHERE Username=%s", (body.username.strip(),), one=True)
    if not u or not bcrypt.checkpw(body.password.encode(), u["PasswordHash"].encode()):
        q.append(now)
        raise HTTPException(401, "Invalid username or password")
    tok = jwt.encode(
        {"sub": str(u["Id"]), "exp": dt.datetime.now(dt.timezone.utc) + dt.timedelta(days=SESSION_DAYS)},
        JWT_SECRET,
        algorithm="HS256",
    )
    secure = request.headers.get("x-forwarded-proto", request.url.scheme) == "https"
    response.set_cookie(COOKIE, tok, httponly=True, samesite="lax", secure=secure, max_age=SESSION_DAYS * 86400, path="/")
    return {"id": u["Id"], "username": u["Username"], "fullName": u["FullName"]}


@app.post("/api/auth/logout")
def logout(response: Response):
    response.delete_cookie(COOKIE, path="/")
    return {"ok": True}


@app.get("/api/auth/me")
def me(uid: int = Depends(current_user)):
    u = db.query("SELECT Id,Username,FullName FROM Users WHERE Id=%s", (uid,), one=True)
    if not u:
        raise HTTPException(401, "Not signed in")
    return {"id": u["Id"], "username": u["Username"], "fullName": u["FullName"]}


class PwIn(BaseModel):
    current: str
    new: str


@app.post("/api/auth/change-password")
def change_password(body: PwIn, uid: int = Depends(current_user)):
    u = db.query("SELECT PasswordHash FROM Users WHERE Id=%s", (uid,), one=True)
    if not bcrypt.checkpw(body.current.encode(), u["PasswordHash"].encode()):
        raise HTTPException(400, "Current password is wrong")
    if len(body.new) < 8:
        raise HTTPException(400, "New password must be at least 8 characters")
    db.execute("UPDATE Users SET PasswordHash=%s WHERE Id=%s", (bcrypt.hashpw(body.new.encode(), bcrypt.gensalt()).decode(), uid))
    return {"ok": True}


@app.get("/api/config")
def config(uid: int = Depends(current_user)):
    # Only the referrer-restricted *browser* key is ever sent to the client.
    return {
        "mapsBrowserKey": MAPS_BROWSER_KEY,
        "mapId": os.environ.get("GOOGLE_MAP_ID", "DEMO_MAP_ID"),
        "routeSearchEnabled": True,
        "routeProvider": "google" if MAPS_SERVER_KEY else "osm",
        "senderMobile": SENDER_MOBILE,
        "billingTypes": BILLING_TYPES,
        "today": today_ist().isoformat(),
    }


# ---------------------------------------------------------------- files
def _save_upload(uid: int, f: UploadFile) -> tuple:
    data = f.file.read(MAX_UPLOAD + 1)
    if len(data) > MAX_UPLOAD:
        raise HTTPException(413, "File is larger than 25 MB")
    ext = Path(f.filename or "").suffix.lower()[:10]
    folder = UPLOAD_DIR / f"u{uid}"
    folder.mkdir(parents=True, exist_ok=True)
    rel = f"u{uid}/{uuid.uuid4().hex}{ext}"
    (UPLOAD_DIR / rel).write_bytes(data)
    mime = f.content_type or mimetypes.guess_type(f.filename or "")[0] or "application/octet-stream"
    return (Path(f.filename or "file").name[:300], rel, mime)


def _delete_file(rel: Optional[str]):
    if rel:
        try:
            (UPLOAD_DIR / rel).unlink(missing_ok=True)
        except OSError:
            pass


def _file_response(rel: str, name: str, mime: Optional[str], inline=True):
    p = (UPLOAD_DIR / rel).resolve()
    if not str(p).startswith(str(UPLOAD_DIR.resolve())) or not p.exists():
        raise HTTPException(404, "File not found")
    disp = "inline" if inline else "attachment"
    return FileResponse(
        p,
        media_type=mime or "application/octet-stream",
        headers={"Content-Disposition": f"{disp}; filename*=UTF-8''{quote(name)}", "Cache-Control": "private, no-store"},
    )


# ---------------------------------------------------------------- projects
def _norm_url(u: Optional[str]) -> Optional[str]:
    u = (u or "").strip()
    if u and not u.lower().startswith(("http://", "https://")):
        u = "https://" + u
    return u or None


def _project_out(r):
    return {
        "id": r["Id"],
        "name": r["Name"],
        "websiteUrl": r["WebsiteUrl"],
        "attachmentName": r["AttachmentName"],
        "hasAttachment": bool(r["AttachmentPath"]),
    }


@app.get("/api/projects")
def list_projects(uid: int = Depends(current_user)):
    rows = db.query("SELECT * FROM Projects WHERE UserId=%s ORDER BY Name", (uid,))
    return [_project_out(r) for r in rows]


@app.post("/api/projects")
def create_project(
    name: str = Form(...), websiteUrl: str = Form(""), file: Optional[UploadFile] = File(None), uid: int = Depends(current_user)
):
    if not name.strip():
        raise HTTPException(400, "Project name is required")
    att = _save_upload(uid, file) if file and file.filename else (None, None, None)
    r = db.execute(
        "INSERT INTO Projects(UserId,Name,WebsiteUrl,AttachmentName,AttachmentPath,AttachmentMime) OUTPUT INSERTED.* VALUES(%s,%s,%s,%s,%s,%s)",
        (uid, name.strip(), _norm_url(websiteUrl), *att),
    )
    return _project_out(r)


def _own_project(uid, pid):
    r = db.query("SELECT * FROM Projects WHERE Id=%s AND UserId=%s", (pid, uid), one=True)
    if not r:
        raise HTTPException(404, "Project not found")
    return r


@app.put("/api/projects/{pid}")
def update_project(
    pid: int,
    name: str = Form(...),
    websiteUrl: str = Form(""),
    removeAttachment: str = Form("0"),
    file: Optional[UploadFile] = File(None),
    uid: int = Depends(current_user),
):
    r = _own_project(uid, pid)
    att = (r["AttachmentName"], r["AttachmentPath"], r["AttachmentMime"])
    if file and file.filename:
        _delete_file(r["AttachmentPath"])
        att = _save_upload(uid, file)
    elif removeAttachment == "1":
        _delete_file(r["AttachmentPath"])
        att = (None, None, None)
    r = db.execute(
        "UPDATE Projects SET Name=%s,WebsiteUrl=%s,AttachmentName=%s,AttachmentPath=%s,AttachmentMime=%s,UpdatedAt=SYSUTCDATETIME() "
        "OUTPUT INSERTED.* WHERE Id=%s AND UserId=%s",
        (name.strip(), _norm_url(websiteUrl), *att, pid, uid),
    )
    return _project_out(r)


@app.delete("/api/projects/{pid}")
def delete_project(pid: int, uid: int = Depends(current_user)):
    r = _own_project(uid, pid)
    db.execute("DELETE FROM ShareLinks WHERE ProjectId=%s; DELETE FROM Projects WHERE Id=%s AND UserId=%s", (pid, pid, uid))
    _delete_file(r["AttachmentPath"])
    return {"ok": True}


@app.get("/api/projects/{pid}/attachment")
def project_attachment(pid: int, uid: int = Depends(current_user)):
    r = _own_project(uid, pid)
    if not r["AttachmentPath"]:
        raise HTTPException(404, "No attachment")
    return _file_response(r["AttachmentPath"], r["AttachmentName"], r["AttachmentMime"])


# ---------------------------------------------------------------- customers
class CustomerIn(BaseModel):
    name: str
    mobile: str
    url: Optional[str] = None
    contactPerson: Optional[str] = None
    address: Optional[str] = None
    startDate: Optional[dt.date] = None
    endDate: Optional[dt.date] = None
    duration: Optional[str] = None


def _cust_out(r):
    return {
        "id": r["Id"], "name": r["Name"], "mobile": r["Mobile"],
        "url": r.get("Url") or "", "contactPerson": r.get("ContactPerson") or "", "address": r.get("Address") or "",
        "startDate": r["StartDate"].isoformat() if r.get("StartDate") else None,
        "endDate": r["EndDate"].isoformat() if r.get("EndDate") else None,
        "duration": r.get("Duration") or "",
    }


def _cust_vals(body: CustomerIn):
    if not body.name.strip() or not body.mobile.strip():
        raise HTTPException(400, "Name and mobile are required")
    if body.startDate and body.endDate and body.endDate < body.startDate:
        raise HTTPException(400, "End date cannot be before start date")
    clean = lambda v: (v or "").strip() or None
    return (body.name.strip(), body.mobile.strip(), clean(body.url), clean(body.contactPerson), clean(body.address),
            body.startDate, body.endDate, clean(body.duration))


@app.get("/api/customers")
def list_customers(uid: int = Depends(current_user)):
    return [_cust_out(r) for r in db.query("SELECT * FROM Customers WHERE UserId=%s ORDER BY Name", (uid,))]


@app.post("/api/customers")
def create_customer(body: CustomerIn, uid: int = Depends(current_user)):
    r = db.execute(
        "INSERT INTO Customers(UserId,Name,Mobile,Url,ContactPerson,Address,StartDate,EndDate,Duration) OUTPUT INSERTED.* "
        "VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s)", (uid, *_cust_vals(body))
    )
    return _cust_out(r)


@app.put("/api/customers/{cid}")
def update_customer(cid: int, body: CustomerIn, uid: int = Depends(current_user)):
    r = db.execute(
        "UPDATE Customers SET Name=%s,Mobile=%s,Url=%s,ContactPerson=%s,Address=%s,StartDate=%s,EndDate=%s,Duration=%s "
        "OUTPUT INSERTED.* WHERE Id=%s AND UserId=%s", (*_cust_vals(body), cid, uid)
    )
    if not r:
        raise HTTPException(404, "Customer not found")
    return _cust_out(r)


@app.delete("/api/customers/{cid}")
def delete_customer(cid: int, uid: int = Depends(current_user)):
    db.execute("DELETE FROM Customers WHERE Id=%s AND UserId=%s", (cid, uid))
    return {"ok": True}


# ---------------------------------------------------------------- project share
class ShareItem(BaseModel):
    projectId: int
    includeAttachment: bool = False


class ShareIn(BaseModel):
    customerId: int
    items: List[ShareItem]


def _wa_number(m: str) -> str:
    d = "".join(ch for ch in m if ch.isdigit())
    if len(d) == 10:
        d = "91" + d
    elif len(d) == 11 and d.startswith("0"):
        d = "91" + d[1:]
    return d


@app.post("/api/share")
def share(body: ShareIn, request: Request, uid: int = Depends(current_user)):
    cust = db.query("SELECT * FROM Customers WHERE Id=%s AND UserId=%s", (body.customerId, uid), one=True)
    if not cust:
        raise HTTPException(404, "Customer not found")
    if not body.items:
        raise HTTPException(400, "Select at least one project")
    base = PUBLIC_BASE_URL or str(request.base_url).rstrip("/")
    exp = dt.datetime.utcnow() + dt.timedelta(hours=SHARE_HOURS)
    lines = [f"Hello {cust['Name']},", "", "Please find our project details below:", ""]
    for n, it in enumerate(body.items, 1):
        p = _own_project(uid, it.projectId)
        lines.append(f"{n}. *{p['Name']}*")
        if p["WebsiteUrl"]:
            lines.append(f"   Website: {p['WebsiteUrl']}")
        if it.includeAttachment and p["AttachmentPath"]:
            tok = secrets.token_urlsafe(24)
            db.execute(
                "INSERT INTO ShareLinks(Token,UserId,ProjectId,CustomerId,ExpiresAt) VALUES(%s,%s,%s,%s,%s)",
                (tok, uid, p["Id"], cust["Id"], exp),
            )
            lines.append(f"   {p['AttachmentName']} (link valid 24 hours): {base}/s/{tok}")
        lines.append("")
    lines.append(f"For more details, contact: {SENDER_MOBILE}")
    lines.append("Thangam Info tech")
    text = "\n".join(lines)
    return {"message": text, "whatsappUrl": f"https://wa.me/{_wa_number(cust['Mobile'])}?text={quote(text)}"}


_EXPIRED_HTML = """<!doctype html><meta name=viewport content="width=device-width,initial-scale=1">
<title>Link expired</title><body style="font-family:system-ui;display:grid;place-items:center;min-height:90vh;color:#334">
<div style="text-align:center"><h2>This link has expired</h2><p>Shared files are available for 24 hours.<br>
Please contact {m} for a new link.</p></div></body>"""


@app.get("/s/{token}")
def shared_file(token: str):
    r = db.query(
        "SELECT p.AttachmentName,p.AttachmentPath,p.AttachmentMime,s.ExpiresAt FROM ShareLinks s JOIN Projects p ON p.Id=s.ProjectId WHERE s.Token=%s",
        (token,),
        one=True,
    )
    if not r or not r["AttachmentPath"] or r["ExpiresAt"] < dt.datetime.utcnow():
        return HTMLResponse(_EXPIRED_HTML.format(m=SENDER_MOBILE), status_code=410)
    return _file_response(r["AttachmentPath"], r["AttachmentName"], r["AttachmentMime"])


# ---------------------------------------------------------------- visits
class VisitIn(BaseModel):
    clinicName: str
    doctorName: Optional[str] = None
    visitDate: dt.date
    followUpDate: Optional[dt.date] = None
    referralDoctor: Optional[str] = None
    personMet: Optional[str] = None
    notes: Optional[str] = None
    status: str = "Visited"
    latitude: Optional[float] = None
    longitude: Optional[float] = None
    locationText: Optional[str] = None


CLOSED_STATUSES = ("Converted", "Not interested", "Closed")


def _visit_out(r):
    fu = r["FollowUpDate"]
    return {
        "id": r["Id"],
        "clinicName": r["ClinicName"],
        "doctorName": r["DoctorName"],
        "visitDate": r["VisitDate"],
        "followUpDate": fu,
        "referralDoctor": r["ReferralDoctor"],
        "personMet": r["PersonMet"],
        "notes": r["Notes"],
        "status": r["Status"],
        "latitude": r["Latitude"],
        "longitude": r["Longitude"],
        "locationText": r["LocationText"],
        "overdue": bool(fu and fu < today_ist() and r["Status"] not in CLOSED_STATUSES),
        "imageCount": r.get("ImageCount", 0),
    }


@app.get("/api/visits")
def list_visits(q: str = "", uid: int = Depends(current_user)):
    sql = (
        "SELECT v.*, (SELECT COUNT(*) FROM VisitImages i WHERE i.VisitId=v.Id) ImageCount FROM Visits v "
        "WHERE v.UserId=%s AND v.IsDeleted=0"
    )
    params: list = [uid]
    if q.strip():
        sql += " AND (v.ClinicName LIKE %s OR v.DoctorName LIKE %s OR v.PersonMet LIKE %s OR v.Notes LIKE %s)"
        params += [f"%{q.strip()}%"] * 4
    sql += " ORDER BY v.VisitDate DESC, v.Id DESC"
    return [_visit_out(r) for r in db.query(sql, tuple(params))]


@app.get("/api/visits/followups")
def followups(uid: int = Depends(current_user)):
    rows = db.query(
        "SELECT v.*, 0 ImageCount FROM Visits v WHERE v.UserId=%s AND v.IsDeleted=0 AND v.FollowUpDate IS NOT NULL ORDER BY v.FollowUpDate, v.ClinicName",
        (uid,),
    )
    return {"today": today_ist(), "visits": [_visit_out(r) for r in rows]}


def _own_visit(uid, vid):
    r = db.query("SELECT v.*, 0 ImageCount FROM Visits v WHERE Id=%s AND UserId=%s AND IsDeleted=0", (vid, uid), one=True)
    if not r:
        raise HTTPException(404, "Visit not found")
    return r


@app.get("/api/visits/{vid}")
def get_visit(vid: int, uid: int = Depends(current_user)):
    out = _visit_out(_own_visit(uid, vid))
    out["images"] = [
        {"id": i["Id"], "fileName": i["FileName"]}
        for i in db.query("SELECT Id,FileName FROM VisitImages WHERE VisitId=%s AND UserId=%s ORDER BY Id", (vid, uid))
    ]
    return out


def _visit_params(b: VisitIn):
    if not b.clinicName.strip():
        raise HTTPException(400, "Clinic name is required")
    s = lambda v: (v or "").strip() or None  # noqa: E731
    return (
        b.clinicName.strip(), s(b.doctorName), b.visitDate, b.followUpDate, s(b.referralDoctor), s(b.personMet),
        s(b.notes), b.status or "Visited", b.latitude, b.longitude, s(b.locationText),
    )


@app.post("/api/visits")
def create_visit(body: VisitIn, uid: int = Depends(current_user)):
    r = db.execute(
        "INSERT INTO Visits(UserId,ClinicName,DoctorName,VisitDate,FollowUpDate,ReferralDoctor,PersonMet,Notes,Status,Latitude,Longitude,LocationText) "
        "OUTPUT INSERTED.Id VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)",
        (uid, *_visit_params(body)),
    )
    return {"id": r["Id"]}


@app.put("/api/visits/{vid}")
def update_visit(vid: int, body: VisitIn, uid: int = Depends(current_user)):
    _own_visit(uid, vid)
    db.execute(
        "UPDATE Visits SET ClinicName=%s,DoctorName=%s,VisitDate=%s,FollowUpDate=%s,ReferralDoctor=%s,PersonMet=%s,Notes=%s,Status=%s,"
        "Latitude=%s,Longitude=%s,LocationText=%s,UpdatedAt=SYSUTCDATETIME() WHERE Id=%s AND UserId=%s",
        (*_visit_params(body), vid, uid),
    )
    return {"id": vid}


@app.delete("/api/visits/{vid}")
def delete_visit(vid: int, uid: int = Depends(current_user)):
    db.execute("UPDATE Visits SET IsDeleted=1,UpdatedAt=SYSUTCDATETIME() WHERE Id=%s AND UserId=%s", (vid, uid))
    return {"ok": True}


@app.post("/api/visits/{vid}/images")
def add_visit_images(vid: int, files: List[UploadFile] = File(...), uid: int = Depends(current_user)):
    _own_visit(uid, vid)
    out = []
    for f in files:
        if not (f.content_type or "").startswith("image/"):
            raise HTTPException(400, f"{f.filename} is not an image")
        name, rel, mime = _save_upload(uid, f)
        r = db.execute(
            "INSERT INTO VisitImages(VisitId,UserId,FileName,FilePath,Mime) OUTPUT INSERTED.Id VALUES(%s,%s,%s,%s,%s)", (vid, uid, name, rel, mime)
        )
        out.append({"id": r["Id"], "fileName": name})
    return out


@app.get("/api/visit-images/{iid}")
def visit_image(iid: int, uid: int = Depends(current_user)):
    r = db.query("SELECT * FROM VisitImages WHERE Id=%s AND UserId=%s", (iid, uid), one=True)
    if not r:
        raise HTTPException(404, "Image not found")
    return _file_response(r["FilePath"], r["FileName"], r["Mime"])


@app.delete("/api/visit-images/{iid}")
def delete_visit_image(iid: int, uid: int = Depends(current_user)):
    r = db.query("SELECT * FROM VisitImages WHERE Id=%s AND UserId=%s", (iid, uid), one=True)
    if r:
        db.execute("DELETE FROM VisitImages WHERE Id=%s", (iid,))
        _delete_file(r["FilePath"])
    return {"ok": True}


class TranslateIn(BaseModel):
    text: str
    target: str = "ta"


def _gtx_translate(text: str, target: str = "ta") -> str:
    """Google's free web translator (no key). Line breaks in the input are kept in the output."""
    r = httpx.get(
        "https://translate.googleapis.com/translate_a/single",
        params={"client": "gtx", "sl": "auto", "tl": target, "dt": "t", "q": text},
        timeout=15,
    )
    r.raise_for_status()
    return "".join(seg[0] for seg in r.json()[0] if seg and seg[0])


@app.post("/api/translate")
def translate(body: TranslateIn, uid: int = Depends(current_user)):
    text = body.text.strip()
    if not text:
        return {"text": ""}
    if len(text) > 5000:
        raise HTTPException(400, "Text too long")
    target = "ta" if body.target not in ("ta", "en") else body.target
    try:
        return {"text": _gtx_translate(text, target)}
    except Exception:
        raise HTTPException(502, "Translation service is not available right now")


# ---------------------------------------------------------------- client route
CATEGORIES = {
    "pharmacy": {"label": "Pharmacy", "query": "pharmacy medical shop", "type": "pharmacy"},
    "clinic": {"label": "Clinic", "query": "clinic doctor", "type": None},
    "lab": {"label": "Lab", "query": "diagnostic laboratory lab", "type": None},
}
_route_cache: dict = {}
_route_usage: dict = defaultdict(deque)
ROUTE_MAX_PER_DAY = int(os.environ.get("ROUTE_MAX_PER_DAY", "150"))
ROUTE_RADIUS_M = 2000


class RouteIn(BaseModel):
    origin: str
    destination: str
    category: str = "all"


def _g_post(url, body, fields):
    r = httpx.post(
        url,
        json=body,
        headers={"X-Goog-Api-Key": MAPS_SERVER_KEY, "X-Goog-FieldMask": fields, "Content-Type": "application/json"},
        timeout=30,
    )
    if r.status_code != 200:
        try:
            msg = r.json().get("error", {}).get("message", r.text[:200])
        except Exception:
            msg = r.text[:200]
        raise HTTPException(502, f"Google API error: {msg}")
    return r.json()


@app.post("/api/route/search")
def route_search(body: RouteIn, uid: int = Depends(current_user)):
    origin, dest = body.origin.strip(), body.destination.strip()
    if not origin or not dest:
        raise HTTPException(400, "Enter both From and To")
    cats = list(CATEGORIES) if body.category == "all" else [body.category]
    if any(c not in CATEGORIES for c in cats):
        raise HTTPException(400, "Unknown category")
    key = (uid, origin.lower(), dest.lower(), tuple(cats))
    hit = _route_cache.get(key)
    if hit and time.time() - hit[0] < 3600:
        return hit[1]
    q = _route_usage[uid]
    now = time.time()
    while q and now - q[0] > 86400:
        q.popleft()
    if len(q) >= ROUTE_MAX_PER_DAY:
        raise HTTPException(429, "Daily route search limit reached")
    q.append(now)

    out = _google_route(origin, dest, cats) if MAPS_SERVER_KEY else _osm_route(origin, dest, cats)
    if not out.get("warning"):
        _route_cache[key] = (time.time(), out)
    if len(_route_cache) > 300:
        _route_cache.pop(next(iter(_route_cache)))
    return out


# ---- free fallback: Nominatim (geocode) + OSRM (driving route) + Overpass (places)
OSM_UA = {"User-Agent": "ClientMap/1.0 (https://clientmap.thangaminfotech.com)"}
OVERPASS_URLS = ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter"]


GENERIC_WORDS = {
    "bus", "stand", "stop", "busstand", "busstop", "near", "opp", "opposite", "junction", "jn", "signal", "main", "road", "rd",
    "street", "st", "new", "old", "railway", "station", "tamil", "nadu", "tamilnadu", "india", "district", "the", "and",
}


def _nominatim(q):
    r = httpx.get("https://nominatim.openstreetmap.org/search",
                  params={"q": q, "format": "json", "limit": 5, "countrycodes": "in"}, headers=OSM_UA, timeout=20)
    r.raise_for_status()
    return [(float(x["lat"]), float(x["lon"]), x.get("display_name", "")) for x in r.json()]


def _photon(q):
    r = httpx.get("https://photon.komoot.io/api/", params={"q": q, "limit": 5, "bbox": "68,6,98,37"}, headers=OSM_UA, timeout=20)
    r.raise_for_status()
    out = []
    for f in r.json().get("features", []):
        p = f.get("properties", {})
        if p.get("countrycode", "IN").upper() != "IN":
            continue
        lng, lat = f["geometry"]["coordinates"][:2]
        label = " ".join(str(p.get(k, "")) for k in ("name", "street", "district", "city", "county", "state"))
        out.append((lat, lng, label))
    return out


def _geocode(q: str):
    """Tolerant place lookup: tries the full text, then a cleaned-up version, with two free geocoders,
    and only accepts a result whose name contains the main place word (e.g. 'Neelambur')."""
    q = re.sub(r"\s+", " ", q).strip(" ,")
    parts = [p.strip() for p in q.split(",") if p.strip()]
    first = parts[0] if parts else q
    words = [w for w in re.findall(r"[A-Za-z஀-௿]+", first) if w.lower() not in GENERIC_WORDS and len(w) > 2]
    key = words[0].lower() if words else first.lower()
    core = " ".join(words) or first
    rest = [p for p in parts[1:] if p.lower().replace(" ", "") not in ("tamilnadu", "india")]
    candidates = list(dict.fromkeys(filter(None, [q, ", ".join([core] + rest), core + ", Tamil Nadu", core])))
    busy, fallback = False, None
    for cand in candidates:
        for fn in (_photon, _nominatim):
            try:
                res = fn(cand)
            except Exception:
                busy = True
                continue
            for lat, lng, label in res:
                if key in label.lower():
                    return lat, lng
            if res and fallback is None and cand != q:
                fallback = res[0][:2]
    if fallback:
        return fallback
    if busy:
        raise HTTPException(502, "Location lookup service is busy. Please try again.")
    raise HTTPException(404, f"Could not find the place: {q}. Try a nearby area or landmark name.")


def _osm_category(tags: dict):
    a, h, s, n = tags.get("amenity"), tags.get("healthcare"), tags.get("shop"), tags.get("name", "").lower()
    if a == "pharmacy" or h == "pharmacy" or s in ("chemist", "medical_supply", "pharmacy"):
        return "pharmacy"
    if s and re.search(r"medicals|pharma|chemist|drug", n):
        return "pharmacy"
    if h in ("laboratory", "diagnostics") or re.search(r"\b(labs?|laborator\w*|diagnostics?|scans?)\b", n):
        return "lab"
    if a in ("clinic", "doctors", "dentist") or h in ("clinic", "doctor"):
        return "clinic"
    return None


PHOTON_QUERIES = {
    "pharmacy": [("medical", ["amenity:pharmacy", "shop:chemist", "shop:medical_supply", "healthcare:pharmacy", "shop:pharmacy"]),
                 ("pharmacy", ["amenity:pharmacy", "shop:chemist", "shop:medical_supply", "healthcare:pharmacy", "shop:pharmacy"]),
                 ("medicals", []), ("pharma", []), ("chemist", [])],
    "clinic": [("clinic", ["amenity:clinic", "amenity:doctors", "healthcare:clinic", "healthcare:doctor", "amenity:dentist"]),
               ("doctor", ["amenity:clinic", "amenity:doctors", "healthcare:clinic", "healthcare:doctor"]),
               ("dental", ["amenity:dentist", "amenity:clinic"])],
    "lab": [("lab", []), ("diagnostic", []), ("scans", []), ("laboratory", [])],
}


def _photon_places(boxes, cats):
    """Free places search via Photon (fast). Returns Overpass-like {"elements": [...]} or None if it failed."""
    from concurrent.futures import ThreadPoolExecutor

    jobs = [(box, q, tags) for box in boxes for c in cats for q, tags in PHOTON_QUERIES[c]]

    def one(job):
        (la1, lo1, la2, lo2), q, tags = job
        params = [("q", q), ("bbox", f"{lo1:.5f},{la1:.5f},{lo2:.5f},{la2:.5f}"), ("limit", "50")] + [("osm_tag", t) for t in tags]
        r = httpx.get("https://photon.komoot.io/api/", params=params, headers=OSM_UA, timeout=25)
        r.raise_for_status()
        return r.json().get("features", [])

    els, failures = [], 0
    with ThreadPoolExecutor(max_workers=6) as ex:
        for res in ex.map(lambda j: _safe(one, j), jobs):
            if res is None:
                failures += 1
                continue
            for f in res:
                pr = f.get("properties", {})
                if pr.get("osm_key") not in ("amenity", "shop", "healthcare"):
                    continue
                lng, lat = f["geometry"]["coordinates"][:2]
                tags = {pr["osm_key"]: pr.get("osm_value"), "name": pr.get("name"), "addr:street": pr.get("street"),
                        "addr:housenumber": pr.get("housenumber"), "addr:suburb": pr.get("district"),
                        "addr:city": pr.get("city"), "addr:postcode": pr.get("postcode")}
                els.append({"type": {"N": "node", "W": "way", "R": "relation"}.get(pr.get("osm_type"), "node"),
                            "id": pr.get("osm_id"), "lat": lat, "lon": lng, "tags": {k: v for k, v in tags.items() if v}})
    if jobs and failures > len(jobs) // 2:
        return None
    return {"elements": els}


def _safe(fn, arg):
    try:
        return fn(arg)
    except Exception:
        return None


def _overpass_places(boxes, cats):
    sel = ['["healthcare"~"^(pharmacy|clinic|doctor|laboratory|diagnostics)$"]']
    if "pharmacy" in cats:
        sel += ['["amenity"="pharmacy"]', '["shop"~"^(chemist|medical_supply|pharmacy)$"]']
    if "clinic" in cats or "lab" in cats:
        sel += ['["amenity"~"^(clinic|doctors|dentist)$"]']
    bb = [f"{a:.5f},{b:.5f},{c:.5f},{d:.5f}" for a, b, c, d in boxes]
    query = f"[out:json][timeout:60];({''.join(f'nwr{s}({x});' for x in bb for s in sel)});out center tags;"
    for url in OVERPASS_URLS:
        try:
            resp = httpx.post(url, data={"data": query}, headers=OSM_UA, timeout=70)
            if resp.status_code == 200:
                return resp.json()
        except Exception:
            continue
    return None


def _spread(items, total, limit):
    """Pick up to `limit` places spread along the whole route (round-robin over 10 stretches,
    closest to the road first) instead of only the ones bunched near the start."""
    if len(items) <= limit:
        return items
    buckets = defaultdict(list)
    for it in sorted(items, key=lambda x: x["offRouteM"]):
        buckets[min(9, int(10 * it["fromStartM"] / (total or 1)))].append(it)
    out = []
    while len(out) < limit and any(buckets.values()):
        for b in range(10):
            if buckets[b] and len(out) < limit:
                out.append(buckets[b].pop(0))
    return out


def _osm_route(origin, dest, cats):
    a, b = _geocode(origin), _geocode(dest)
    try:
        r = httpx.get(
            f"https://router.project-osrm.org/route/v1/driving/{a[1]},{a[0]};{b[1]},{b[0]}",
            params={"overview": "full", "geometries": "polyline"}, headers=OSM_UA, timeout=30,
        )
        r.raise_for_status()
        rj = r.json()
    except Exception:
        raise HTTPException(502, "Routing service is busy. Please try again.")
    if rj.get("code") != "Ok" or not rj.get("routes"):
        raise HTTPException(404, "No driving route found between these places")
    rt = rj["routes"][0]
    enc = rt["geometry"]
    route = Route(decode_polyline(enc))
    # split the route into ~15 km pieces, query each piece's bounding box (+2 km),
    # then measure real distance from the route locally
    total = route.cum[-1] or 1
    n_chunks = max(1, min(25, int(total // 15000) + 1))
    pad_lat = ROUTE_RADIUS_M / 110540
    boxes = []
    for k in range(n_chunks):
        lo_d, hi_d = total * k / n_chunks, total * (k + 1) / n_chunks
        seg = [p for p, d in zip(route.pts, route.cum) if lo_d <= d <= hi_d] or [route.pts[0]]
        la = [p[0] for p in seg]
        lo = [p[1] for p in seg]
        pad_lng = ROUTE_RADIUS_M / (111320 * max(0.2, math.cos(math.radians(sum(la) / len(la)))))
        boxes.append((min(la) - pad_lat, min(lo) - pad_lng, max(la) + pad_lat, max(lo) + pad_lng))
    data, warning = _photon_places(boxes, cats), None
    if data is None:
        data = _overpass_places(boxes, cats)
    if data is None:
        data, warning = {"elements": []}, "The places service is busy, so only the route is shown. Please search again in a minute."
    found = defaultdict(list)
    seen = set()
    for el in data.get("elements", []):
        tags = el.get("tags", {})
        name = tags.get("name") or tags.get("name:en")
        lat = el.get("lat") or el.get("center", {}).get("lat")
        lng = el.get("lon") or el.get("center", {}).get("lon")
        cat = _osm_category(tags)
        if not name or lat is None or cat not in cats:
            continue
        k = (name.lower(), round(lat, 4), round(lng, 4))
        if k in seen:
            continue
        seen.add(k)
        along, off = route.locate((lat, lng))
        if off > ROUTE_RADIUS_M:
            continue
        addr = ", ".join(
            x for x in (
                " ".join(filter(None, [tags.get("addr:housenumber"), tags.get("addr:street")])),
                tags.get("addr:suburb") or tags.get("addr:place"), tags.get("addr:city"), tags.get("addr:postcode"),
            ) if x
        )
        found[cat].append({
            "id": f"osm-{el['type']}-{el['id']}", "name": name, "address": addr or "Address not listed",
            "lat": lat, "lng": lng, "category": cat, "fromStartM": round(along), "offRouteM": round(off),
            "mapsUrl": f"https://www.google.com/maps/search/?api=1&query={lat},{lng}",
        })
    places = []
    for c in cats:
        places += _spread(found[c], route.cum[-1], 20)
    places.sort(key=lambda x: x["fromStartM"])
    for i, p in enumerate(places, 1):
        p["seq"] = i
    return {
        "provider": "osm", "polyline": enc, "distanceM": round(rt.get("distance", 0)), "duration": f"{round(rt.get('duration', 0))}s",
        "start": {"latitude": a[0], "longitude": a[1]}, "end": {"latitude": b[0], "longitude": b[1]},
        "places": places, "origin": origin, "destination": dest, "warning": warning,
    }


def _google_route(origin, dest, cats):
    rd = _g_post(
        "https://routes.googleapis.com/directions/v2:computeRoutes",
        {"origin": {"address": origin}, "destination": {"address": dest}, "travelMode": "DRIVE", "languageCode": "en-IN", "regionCode": "IN"},
        "routes.distanceMeters,routes.duration,routes.polyline.encodedPolyline,routes.legs.startLocation,routes.legs.endLocation,routes.viewport",
    )
    if not rd.get("routes"):
        raise HTTPException(404, "No driving route found between these places")
    rt = rd["routes"][0]
    enc = rt["polyline"]["encodedPolyline"]
    route = Route(decode_polyline(enc))
    legs = rt.get("legs") or [{}]
    start = legs[0].get("startLocation", {}).get("latLng") or {"latitude": route.pts[0][0], "longitude": route.pts[0][1]}
    end = legs[-1].get("endLocation", {}).get("latLng") or {"latitude": route.pts[-1][0], "longitude": route.pts[-1][1]}

    seen, places = set(), []
    for c in cats:
        meta = CATEGORIES[c]
        req = {"textQuery": meta["query"], "searchAlongRouteParameters": {"polyline": {"encodedPolyline": enc}}, "pageSize": 20, "regionCode": "IN"}
        if meta["type"]:
            req["includedType"] = meta["type"]
        pr = _g_post(
            "https://places.googleapis.com/v1/places:searchText",
            req,
            "places.id,places.displayName,places.formattedAddress,places.location,places.googleMapsUri",
        )
        for p in pr.get("places", [])[:20]:
            if p["id"] in seen or "location" not in p:
                continue
            loc = p["location"]
            along, off = route.locate((loc["latitude"], loc["longitude"]))
            if off > ROUTE_RADIUS_M:
                continue
            seen.add(p["id"])
            places.append(
                {
                    "id": p["id"],
                    "name": p.get("displayName", {}).get("text", ""),
                    "address": p.get("formattedAddress", ""),
                    "lat": loc["latitude"],
                    "lng": loc["longitude"],
                    "category": c,
                    "fromStartM": round(along),
                    "offRouteM": round(off),
                    "mapsUrl": p.get("googleMapsUri"),
                }
            )
    places.sort(key=lambda x: x["fromStartM"])
    for i, p in enumerate(places, 1):
        p["seq"] = i
    return {
        "provider": "google",
        "polyline": enc,
        "distanceM": rt.get("distanceMeters", 0),
        "duration": rt.get("duration", ""),
        "start": start,
        "end": end,
        "viewport": rt.get("viewport"),
        "places": places,
        "origin": origin,
        "destination": dest,
    }


# ---------------------------------------------------------------- clinics
# ---------------------------------------------------------------- near me (places around the current location)
# Categories and distances are small per-user lists the user can add to, edit and delete
# (Lookups table: kind "near_cat" = name + search words, kind "near_km" = distance in km).
DEFAULT_NEAR_CATS = [("Pharmacy", "pharmacy medical shop"), ("Lab", "diagnostic laboratory lab")]
DEFAULT_NEAR_KM = ["1", "2", "5", "10"]
LOOKUP_KINDS = ("near_cat", "near_km")
NEAR_MAX_CATS = 8          # "All" runs one search per category
_nearby_cache: dict = {}


class LookupIn(BaseModel):
    name: str = ""
    value: Optional[str] = None


def _lookup_out(r):
    return {"id": r["Id"], "name": r["Name"], "value": r["Value"] or ""}


def _lookup_rows(uid: int, kind: str):
    sql = "SELECT * FROM Lookups WHERE UserId=%s AND Kind=%s AND IsDeleted=0 ORDER BY SortOrder,Id"
    rows = db.query(sql, (uid, kind))
    if not rows and not db.query("SELECT TOP 1 Id FROM Lookups WHERE UserId=%s AND Kind=%s", (uid, kind), one=True):
        seed = DEFAULT_NEAR_CATS if kind == "near_cat" else [(f"{k} km", k) for k in DEFAULT_NEAR_KM]
        for i, (n, v) in enumerate(seed):
            db.execute("INSERT INTO Lookups(UserId,Kind,Name,Value,SortOrder) VALUES(%s,%s,%s,%s,%s)", (uid, kind, n, v, i))
        rows = db.query(sql, (uid, kind))
    if kind == "near_km":
        rows = sorted(rows, key=lambda r: float(r["Value"] or 0))
    return rows


def _lookup_vals(kind: str, body: LookupIn):
    if kind not in LOOKUP_KINDS:
        raise HTTPException(404, "Unknown list")
    if kind == "near_cat":
        name = body.name.strip()
        if not name:
            raise HTTPException(400, "Category name is required")
        return name[:100], ((body.value or "").strip() or name)[:300]
    raw = (body.value or body.name or "").lower().replace("km", "").strip()
    try:
        km = float(raw)
    except ValueError:
        raise HTTPException(400, "Enter the distance in km, for example 3")
    if not 0.1 <= km <= 50:
        raise HTTPException(400, "Distance must be between 0.1 and 50 km")
    v = f"{km:g}"
    return f"{v} km", v


@app.get("/api/lookups/{kind}")
def list_lookups(kind: str, uid: int = Depends(current_user)):
    if kind not in LOOKUP_KINDS:
        raise HTTPException(404, "Unknown list")
    return [_lookup_out(r) for r in _lookup_rows(uid, kind)]


@app.post("/api/lookups/{kind}")
def add_lookup(kind: str, body: LookupIn, uid: int = Depends(current_user)):
    name, value = _lookup_vals(kind, body)
    r = db.execute(
        "INSERT INTO Lookups(UserId,Kind,Name,Value,SortOrder) OUTPUT INSERTED.* "
        "VALUES(%s,%s,%s,%s,(SELECT ISNULL(MAX(SortOrder),0)+1 FROM Lookups WHERE UserId=%s AND Kind=%s))",
        (uid, kind, name, value, uid, kind),
    )
    return _lookup_out(r)


@app.put("/api/lookups/{kind}/{lid}")
def update_lookup(kind: str, lid: int, body: LookupIn, uid: int = Depends(current_user)):
    name, value = _lookup_vals(kind, body)
    r = db.execute(
        "UPDATE Lookups SET Name=%s,Value=%s OUTPUT INSERTED.* WHERE Id=%s AND UserId=%s AND Kind=%s AND IsDeleted=0",
        (name, value, lid, uid, kind),
    )
    if not r:
        raise HTTPException(404, "Item not found")
    return _lookup_out(r)


@app.delete("/api/lookups/{kind}/{lid}")
def delete_lookup(kind: str, lid: int, uid: int = Depends(current_user)):
    if kind not in LOOKUP_KINDS:
        raise HTTPException(404, "Unknown list")
    left = db.query("SELECT COUNT(*) n FROM Lookups WHERE UserId=%s AND Kind=%s AND IsDeleted=0", (uid, kind), one=True)
    if left and left["n"] <= 1:
        raise HTTPException(400, "Keep at least one item in the list")
    db.execute("UPDATE Lookups SET IsDeleted=1 WHERE Id=%s AND UserId=%s AND Kind=%s", (lid, uid, kind))
    return {"ok": True}


class NearbyIn(BaseModel):
    lat: float
    lng: float
    categoryIds: List[int] = []     # empty = all categories
    radiusKm: float = 2


def _dist_m(a_lat, a_lng, b_lat, b_lng):
    r = 6371000.0
    p1, p2 = math.radians(a_lat), math.radians(b_lat)
    dp, dl = p2 - p1, math.radians(b_lng - a_lng)
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(h))


def _box(lat, lng, radius):
    dlat = radius / 110540
    dlng = radius / (111320 * max(0.2, math.cos(math.radians(lat))))
    return lat - dlat, lng - dlng, lat + dlat, lng + dlng


def _osm_kind(cat):
    """Map a user category onto the built-in OpenStreetMap kinds, if its words match one."""
    t = f"{cat['name']} {cat['query']}".lower()
    if re.search(r"pharm|medical|chemist|drug", t):
        return "pharmacy"
    if re.search(r"\blabs?\b|laborator|diagnos|scan", t):
        return "lab"
    if re.search(r"clinic|doctor|dental|dentist|hospital", t):
        return "clinic"
    return None


def _place(pid, name, cat, address, plat, plng, maps_url, phone="", rating=None, count=None, open_now=None):
    return {"id": pid, "name": name, "category": cat["id"], "categoryName": cat["name"], "address": address,
            "lat": plat, "lng": plng, "phone": phone, "rating": rating, "ratingCount": count, "openNow": open_now,
            "mapsUrl": maps_url}


def _google_nearby(lat, lng, radius, cats):
    la1, lo1, la2, lo2 = _box(lat, lng, radius)
    seen, out = set(), []
    for cat in cats:
        req = {
            "textQuery": cat["query"], "pageSize": 20, "regionCode": "IN", "rankPreference": "DISTANCE",
            "locationRestriction": {"rectangle": {"low": {"latitude": la1, "longitude": lo1}, "high": {"latitude": la2, "longitude": lo2}}},
        }
        if _osm_kind(cat) == "pharmacy":
            req["includedType"] = "pharmacy"
        pr = _g_post(
            "https://places.googleapis.com/v1/places:searchText", req,
            "places.id,places.displayName,places.formattedAddress,places.location,places.googleMapsUri,"
            "places.nationalPhoneNumber,places.rating,places.userRatingCount,places.currentOpeningHours.openNow,places.businessStatus",
        )
        for p in pr.get("places", []):
            if p["id"] in seen or "location" not in p or p.get("businessStatus") == "CLOSED_PERMANENTLY":
                continue
            seen.add(p["id"])
            loc = p["location"]
            out.append(_place(p["id"], p.get("displayName", {}).get("text", ""), cat, p.get("formattedAddress", ""),
                              loc["latitude"], loc["longitude"], p.get("googleMapsUri"), p.get("nationalPhoneNumber", ""),
                              p.get("rating"), p.get("userRatingCount"), (p.get("currentOpeningHours") or {}).get("openNow")))
    return out


def _osm_addr(tags):
    return ", ".join(x for x in (
        " ".join(filter(None, [tags.get("addr:housenumber"), tags.get("addr:street")])),
        tags.get("addr:suburb") or tags.get("addr:place"), tags.get("addr:city"), tags.get("addr:postcode"),
    ) if x)


def _photon_text(box, query):
    """Free-text place search inside a box (for categories that are not pharmacy / lab / clinic)."""
    la1, lo1, la2, lo2 = box
    r = httpx.get("https://photon.komoot.io/api/", headers=OSM_UA, timeout=25,
                  params={"q": query, "bbox": f"{lo1:.5f},{la1:.5f},{lo2:.5f},{la2:.5f}", "limit": "50"})
    r.raise_for_status()
    return r.json().get("features", [])


def _osm_nearby(lat, lng, radius, cats):
    box = _box(lat, lng, radius)
    kinds = {c["id"]: _osm_kind(c) for c in cats}
    builtin = sorted({k for k in kinds.values() if k})
    out, seen = [], set()
    if builtin:
        data = _photon_places([box], builtin) or _overpass_places([box], builtin)
        if data is None:
            raise HTTPException(502, "The places service is busy. Please search again in a minute.")
        for el in data.get("elements", []):
            tags = el.get("tags", {})
            name = tags.get("name") or tags.get("name:en")
            plat = el.get("lat") or el.get("center", {}).get("lat")
            plng = el.get("lon") or el.get("center", {}).get("lon")
            kind = _osm_category(tags)
            cat = next((c for c in cats if kinds[c["id"]] == kind), None)
            if not name or plat is None or not cat:
                continue
            k = (name.lower(), round(plat, 4), round(plng, 4))
            if k in seen:
                continue
            seen.add(k)
            out.append(_place(f"osm-{el['type']}-{el['id']}", name, cat, _osm_addr(tags), plat, plng,
                              f"https://www.google.com/maps/search/?api=1&query={plat},{plng}",
                              tags.get("phone") or tags.get("contact:phone") or ""))
    for cat in (c for c in cats if not kinds[c["id"]]):
        feats = _safe(lambda q: _photon_text(box, q), cat["query"]) or []
        for f in feats:
            pr = f.get("properties", {})
            name = pr.get("name")
            if not name:
                continue
            plng, plat = f["geometry"]["coordinates"][:2]
            k = (name.lower(), round(plat, 4), round(plng, 4))
            if k in seen:
                continue
            seen.add(k)
            addr = ", ".join(x for x in (" ".join(filter(None, [pr.get("housenumber"), pr.get("street")])),
                                         pr.get("district"), pr.get("city"), pr.get("postcode")) if x)
            out.append(_place(f"osm-{pr.get('osm_type', 'N')}-{pr.get('osm_id')}", name, cat, addr, plat, plng,
                              f"https://www.google.com/maps/search/?api=1&query={plat},{plng}"))
    return out


@app.post("/api/nearby")
def nearby(body: NearbyIn, uid: int = Depends(current_user)):
    if not (-90 <= body.lat <= 90 and -180 <= body.lng <= 180):
        raise HTTPException(400, "Invalid location")
    all_cats = [{"id": r["Id"], "name": r["Name"], "query": r["Value"] or r["Name"]} for r in _lookup_rows(uid, "near_cat")]
    cats = [c for c in all_cats if not body.categoryIds or c["id"] in body.categoryIds]
    if not cats:
        raise HTTPException(400, "Choose a category")
    cats = cats[:NEAR_MAX_CATS]
    radius = round(min(50.0, max(0.1, body.radiusKm)) * 1000)
    key = (round(body.lat, 3), round(body.lng, 3), tuple((c["id"], c["query"]) for c in cats), radius)
    hit = _nearby_cache.get(key)
    if hit and time.time() - hit[0] < 1800:
        return hit[1]
    q, now = _route_usage[uid], time.time()   # shares the daily search allowance with Client Route
    while q and now - q[0] > 86400:
        q.popleft()
    if len(q) >= ROUTE_MAX_PER_DAY:
        raise HTTPException(429, "Daily search limit reached")
    q.append(now)

    places = _google_nearby(body.lat, body.lng, radius, cats) if MAPS_SERVER_KEY else _osm_nearby(body.lat, body.lng, radius, cats)
    for p in places:
        p["distanceM"] = round(_dist_m(body.lat, body.lng, p["lat"], p["lng"]))
    places = sorted((p for p in places if p["distanceM"] <= radius * 1.05), key=lambda p: p["distanceM"])[:80]
    out = {"provider": "google" if MAPS_SERVER_KEY else "osm", "radiusM": radius, "places": places}
    _nearby_cache[key] = (time.time(), out)
    if len(_nearby_cache) > 300:
        _nearby_cache.pop(next(iter(_nearby_cache)))
    return out


# ---------------------------------------------------------------- plan to visit (places saved from Near Me)
PLAN_STATUSES = ("Planned", "Visited", "Skipped")


class PlanItemIn(BaseModel):
    placeId: Optional[str] = None
    name: str
    category: Optional[str] = None
    address: Optional[str] = None
    phone: Optional[str] = None
    lat: Optional[float] = None
    lng: Optional[float] = None
    mapsUrl: Optional[str] = None
    rating: Optional[float] = None
    ratingCount: Optional[int] = None


class PlanBulkIn(BaseModel):
    items: List[PlanItemIn]
    planDate: Optional[dt.date] = None


class PlanPatchIn(BaseModel):
    status: Optional[str] = None
    planDate: Optional[dt.date] = None
    clearPlanDate: bool = False
    notes: Optional[str] = None
    visitId: Optional[int] = None


class PlanIdsIn(BaseModel):
    ids: List[int]
    status: Optional[str] = None


def _plan_out(r):
    return {
        "id": r["Id"], "placeId": r["PlaceId"], "name": r["Name"], "category": r["Category"], "address": r["Address"],
        "phone": r["Phone"], "lat": r["Latitude"], "lng": r["Longitude"], "mapsUrl": r["MapsUrl"], "rating": r["Rating"],
        "ratingCount": r["RatingCount"], "planDate": r["PlanDate"], "status": r["Status"], "visitId": r["VisitId"],
        "notes": r["Notes"], "createdAt": r["CreatedAt"],
    }


def _check_status(s):
    if s not in PLAN_STATUSES:
        raise HTTPException(400, "Invalid status")


@app.get("/api/plan")
def list_plan(uid: int = Depends(current_user)):
    rows = db.query(
        "SELECT * FROM PlanVisits WHERE UserId=%s ORDER BY CASE Status WHEN 'Planned' THEN 0 ELSE 1 END, "
        "CASE WHEN PlanDate IS NULL THEN 1 ELSE 0 END, PlanDate, Name",
        (uid,),
    )
    return [_plan_out(r) for r in rows]


@app.post("/api/plan/bulk")
def add_plan(body: PlanBulkIn, uid: int = Depends(current_user)):
    """Add places to the plan; places already in it (same place id, or same name + address) are skipped."""
    if not body.items:
        raise HTTPException(400, "Select at least one place")
    if len(body.items) > 200:
        raise HTTPException(400, "Too many places at once (max 200)")
    have = db.query("SELECT PlaceId, Name, Address FROM PlanVisits WHERE UserId=%s", (uid,))
    ids = {r["PlaceId"] for r in have if r["PlaceId"]}
    keys = {((r["Name"] or "").strip().lower(), (r["Address"] or "").strip().lower()) for r in have}
    s = lambda v, n: ((v or "").strip()[:n] or None)  # noqa: E731
    added = skipped = 0
    with db.conn() as c:
        cur = c.cursor()
        for it in body.items:
            name = (it.name or "").strip()
            key = (name.lower(), (it.address or "").strip().lower())
            if not name or (it.placeId and it.placeId in ids) or key in keys:
                skipped += 1
                continue
            cur.execute(
                "INSERT INTO PlanVisits(UserId,PlaceId,Name,Category,Address,Phone,Latitude,Longitude,MapsUrl,Rating,RatingCount,PlanDate) "
                "VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)",
                (uid, s(it.placeId, 300), name[:300], s(it.category, 100), s(it.address, 600), s(it.phone, 60),
                 it.lat, it.lng, s(it.mapsUrl, 1000), it.rating, it.ratingCount, body.planDate),
            )
            if it.placeId:
                ids.add(it.placeId)
            keys.add(key)
            added += 1
    return {"added": added, "skipped": skipped}


@app.patch("/api/plan/{pid}")
def update_plan(pid: int, body: PlanPatchIn, uid: int = Depends(current_user)):
    r = db.query("SELECT * FROM PlanVisits WHERE Id=%s AND UserId=%s", (pid, uid), one=True)
    if not r:
        raise HTTPException(404, "Plan item not found")
    if body.status is not None:
        _check_status(body.status)
    plan_date = None if body.clearPlanDate else (body.planDate or r["PlanDate"])
    row = db.execute(
        "UPDATE PlanVisits SET Status=%s,PlanDate=%s,Notes=%s,VisitId=%s,UpdatedAt=SYSUTCDATETIME() OUTPUT INSERTED.* "
        "WHERE Id=%s AND UserId=%s",
        (body.status or r["Status"], plan_date, (body.notes.strip() or None) if body.notes is not None else r["Notes"],
         body.visitId if body.visitId is not None else r["VisitId"], pid, uid),
    )
    return _plan_out(row)


def _id_list(ids):
    ids = [int(i) for i in ids][:500]
    if not ids:
        raise HTTPException(400, "Select at least one place")
    return ids, ",".join(["%s"] * len(ids))


@app.post("/api/plan/bulk-status")
def plan_bulk_status(body: PlanIdsIn, uid: int = Depends(current_user)):
    _check_status(body.status)
    ids, ph = _id_list(body.ids)
    db.execute(f"UPDATE PlanVisits SET Status=%s,UpdatedAt=SYSUTCDATETIME() WHERE UserId=%s AND Id IN ({ph})", (body.status, uid, *ids))
    return {"ok": True}


@app.post("/api/plan/bulk-delete")
def plan_bulk_delete(body: PlanIdsIn, uid: int = Depends(current_user)):
    ids, ph = _id_list(body.ids)
    db.execute(f"DELETE FROM PlanVisits WHERE UserId=%s AND Id IN ({ph})", (uid, *ids))
    return {"ok": True}


class ClinicIn(BaseModel):
    name: str
    address: Optional[str] = None
    mobile: Optional[str] = None


def _clinic_out(r):
    return {"id": r["Id"], "name": r["Name"], "address": r["Address"], "mobile": r["Mobile"]}


@app.get("/api/clinics")
def list_clinics(uid: int = Depends(current_user)):
    return [_clinic_out(r) for r in db.query("SELECT * FROM Clinics WHERE UserId=%s ORDER BY Name", (uid,))]


@app.post("/api/clinics")
def create_clinic(body: ClinicIn, uid: int = Depends(current_user)):
    if not body.name.strip():
        raise HTTPException(400, "Clinic name is required")
    r = db.execute(
        "INSERT INTO Clinics(UserId,Name,Address,Mobile) OUTPUT INSERTED.* VALUES(%s,%s,%s,%s)",
        (uid, body.name.strip(), (body.address or "").strip(), (body.mobile or "").strip()),
    )
    return _clinic_out(r)


@app.put("/api/clinics/{cid}")
def update_clinic(cid: int, body: ClinicIn, uid: int = Depends(current_user)):
    r = db.execute(
        "UPDATE Clinics SET Name=%s,Address=%s,Mobile=%s OUTPUT INSERTED.* WHERE Id=%s AND UserId=%s",
        (body.name.strip(), (body.address or "").strip(), (body.mobile or "").strip(), cid, uid),
    )
    if not r:
        raise HTTPException(404, "Clinic not found")
    return _clinic_out(r)


@app.delete("/api/clinics/{cid}")
def delete_clinic(cid: int, uid: int = Depends(current_user)):
    db.execute("DELETE FROM Clinics WHERE Id=%s AND UserId=%s", (cid, uid))
    return {"ok": True}


# ---------------------------------------------------------------- packages
class PackageIn(BaseModel):
    name: str


@app.get("/api/packages")
def list_packages(uid: int = Depends(current_user)):
    rows = db.query("SELECT Id,Name FROM Packages WHERE UserId=%s AND IsDeleted=0 ORDER BY SortOrder,Id", (uid,))
    if not rows and not db.query("SELECT TOP 1 Id FROM Packages WHERE UserId=%s", (uid,), one=True):
        for i, n in enumerate(DEFAULT_PACKAGES):
            db.execute("INSERT INTO Packages(UserId,Name,SortOrder) VALUES(%s,%s,%s)", (uid, n, i))
        rows = db.query("SELECT Id,Name FROM Packages WHERE UserId=%s AND IsDeleted=0 ORDER BY SortOrder,Id", (uid,))
    return [{"id": r["Id"], "name": r["Name"]} for r in rows]


@app.post("/api/packages")
def add_package(body: PackageIn, uid: int = Depends(current_user)):
    if not body.name.strip():
        raise HTTPException(400, "Package name is required")
    r = db.execute(
        "INSERT INTO Packages(UserId,Name,SortOrder) OUTPUT INSERTED.Id,INSERTED.Name "
        "VALUES(%s,%s,(SELECT ISNULL(MAX(SortOrder),0)+1 FROM Packages WHERE UserId=%s))",
        (uid, body.name.strip(), uid),
    )
    return {"id": r["Id"], "name": r["Name"]}


@app.put("/api/packages/{pid}")
def rename_package(pid: int, body: PackageIn, uid: int = Depends(current_user)):
    if not body.name.strip():
        raise HTTPException(400, "Package name is required")
    db.execute("UPDATE Packages SET Name=%s WHERE Id=%s AND UserId=%s", (body.name.strip(), pid, uid))
    return {"id": pid, "name": body.name.strip()}


@app.delete("/api/packages/{pid}")
def remove_package(pid: int, uid: int = Depends(current_user)):
    db.execute("UPDATE Packages SET IsDeleted=1 WHERE Id=%s AND UserId=%s", (pid, uid))
    return {"ok": True}


# ---------------------------------------------------------------- voice to text: Tamil translation
# Speech recognition runs in the browser; translation runs here so no API key ever reaches the page.
# Provider order: Claude (ANTHROPIC_API_KEY) -> Google Cloud Translation (GOOGLE_TRANSLATE_API_KEY)
# -> Google's free web translator (no key, same one the visit notes "Convert to Tamil" uses).
TAMIL_PROMPT = (
    "Convert the provided English speech or text into natural, accurate Tamil. Preserve the original meaning "
    "and tone. Keep each sentence as a separate bullet point, retain names and numbers, and output only the "
    "Tamil translation."
)
TRANSLATE_MODEL = os.environ.get("TRANSLATE_MODEL", "claude-opus-5-5")
TRANSLATE_MAX_CHARS = 6000
TRANSLATE_MAX_PER_DAY = int(os.environ.get("TRANSLATE_MAX_PER_DAY", "300"))
_translate_hits: dict = defaultdict(deque)
_anthropic_client = None


class VoiceTranslateIn(BaseModel):
    text: str


_SENT_SPLIT = re.compile(r"(?<=[.!?।])\s+|\n+")
_BULLET = re.compile(r"^\s*(?:[•\-*·▪●]|\d+[.)])\s*")


def split_sentences(text: str) -> list:
    """One sentence per item; existing bullet markers are dropped."""
    out = []
    for part in _SENT_SPLIT.split(text or ""):
        part = _BULLET.sub("", part).strip()
        if part:
            out.append(part)
    return out


def _bullets(lines: list) -> str:
    return "\n".join(f"• {s}" for s in lines)


def _translate_claude(sentences: list) -> list:
    global _anthropic_client
    import anthropic

    if _anthropic_client is None:
        _anthropic_client = anthropic.Anthropic(timeout=90.0)
    resp = _anthropic_client.beta.messages.create(
        model=TRANSLATE_MODEL,
        max_tokens=16000,
        system=TAMIL_PROMPT,
        output_config={"effort": "low"},
        betas=["server-side-fallback-2026-07-01"],
        fallbacks="default",
        messages=[{"role": "user", "content": _bullets(sentences)}],
    )
    if resp.stop_reason == "refusal":
        raise HTTPException(422, "The translation service declined this text")
    text = "\n".join(b.text for b in resp.content if b.type == "text")
    lines = [_BULLET.sub("", ln).strip() for ln in text.splitlines()]
    return [ln for ln in lines if ln]


def _translate_google(sentences: list, key: str) -> list:
    r = httpx.post(
        "https://translation.googleapis.com/language/translate/v2",
        params={"key": key}, json={"q": sentences, "target": "ta", "format": "text"}, timeout=30,
    )
    if r.status_code != 200:
        try:
            why = r.json()["error"]["message"]
        except Exception:
            why = f"HTTP {r.status_code}"
        print("google translate failed:", why[:300])
        raise HTTPException(502, "Google Translate rejected the request - check GOOGLE_TRANSLATE_API_KEY on the server")
    import html as _html
    return [_html.unescape(t["translatedText"]) for t in r.json()["data"]["translations"]]


def _voice_provider() -> str:
    if os.environ.get("ANTHROPIC_API_KEY"):
        return "claude"
    return "google" if os.environ.get("GOOGLE_TRANSLATE_API_KEY") else "google-free"


@app.post("/api/voice/translate")
def voice_translate(body: VoiceTranslateIn, uid: int = Depends(current_user)):
    text = (body.text or "").strip()
    if not text:
        raise HTTPException(400, "Nothing to translate")
    if len(text) > TRANSLATE_MAX_CHARS:
        raise HTTPException(400, f"Text is too long (max {TRANSLATE_MAX_CHARS} characters)")
    now = time.time()
    q = _translate_hits[uid]
    while q and now - q[0] > 86400:
        q.popleft()
    if len(q) >= TRANSLATE_MAX_PER_DAY:
        raise HTTPException(429, "Daily translation limit reached")
    q.append(now)

    sentences = split_sentences(text)
    provider = _voice_provider()
    try:
        if provider == "claude":
            lines = _translate_claude(sentences)
        elif provider == "google":
            lines = _translate_google(sentences, os.environ["GOOGLE_TRANSLATE_API_KEY"])
        else:
            lines = [ln.strip() for ln in _gtx_translate("\n".join(sentences)).splitlines() if ln.strip()]
    except HTTPException:
        raise
    except Exception as e:  # network / provider errors -> readable message, details in the log
        print("translate failed:", type(e).__name__, str(e)[:300])
        raise HTTPException(502, "Translation failed, please try again")
    return {"translation": _bullets(lines), "provider": provider}


# ---------------------------------------------------------------- durations (customer contract length)
DEFAULT_DURATIONS = [("1 Month", 1), ("3 Months", 3), ("6 Months", 6), ("1 Year", 12), ("2 Years", 24)]


class DurationIn(BaseModel):
    name: str
    months: Optional[int] = None


def _dur_out(r):
    return {"id": r["Id"], "name": r["Name"], "months": r["Months"]}


def _dur_vals(body: DurationIn):
    name = body.name.strip()
    if not name:
        raise HTTPException(400, "Duration name is required")
    if body.months is not None and not (1 <= body.months <= 600):
        raise HTTPException(400, "Months must be between 1 and 600")
    return name, body.months


@app.get("/api/durations")
def list_durations(uid: int = Depends(current_user)):
    sql = "SELECT * FROM Durations WHERE UserId=%s AND IsDeleted=0 ORDER BY SortOrder,Id"
    rows = db.query(sql, (uid,))
    if not rows and not db.query("SELECT TOP 1 Id FROM Durations WHERE UserId=%s", (uid,), one=True):
        for i, (n, m) in enumerate(DEFAULT_DURATIONS):
            db.execute("INSERT INTO Durations(UserId,Name,Months,SortOrder) VALUES(%s,%s,%s,%s)", (uid, n, m, i))
        rows = db.query(sql, (uid,))
    return [_dur_out(r) for r in rows]


@app.post("/api/durations")
def add_duration(body: DurationIn, uid: int = Depends(current_user)):
    name, months = _dur_vals(body)
    r = db.execute(
        "INSERT INTO Durations(UserId,Name,Months,SortOrder) OUTPUT INSERTED.* "
        "VALUES(%s,%s,%s,(SELECT ISNULL(MAX(SortOrder),0)+1 FROM Durations WHERE UserId=%s))",
        (uid, name, months, uid),
    )
    return _dur_out(r)


@app.put("/api/durations/{did}")
def update_duration(did: int, body: DurationIn, uid: int = Depends(current_user)):
    name, months = _dur_vals(body)
    old = db.query("SELECT Name FROM Durations WHERE Id=%s AND UserId=%s AND IsDeleted=0", (did, uid), one=True)
    if not old:
        raise HTTPException(404, "Duration not found")
    r = db.execute("UPDATE Durations SET Name=%s,Months=%s OUTPUT INSERTED.* WHERE Id=%s AND UserId=%s", (name, months, did, uid))
    if old["Name"] != name:  # keep customers pointing at the renamed value
        db.execute("UPDATE Customers SET Duration=%s WHERE UserId=%s AND Duration=%s", (name, uid, old["Name"]))
    return _dur_out(r)


@app.delete("/api/durations/{did}")
def remove_duration(did: int, uid: int = Depends(current_user)):
    db.execute("UPDATE Durations SET IsDeleted=1 WHERE Id=%s AND UserId=%s", (did, uid))
    return {"ok": True}


# ---------------------------------------------------------------- invoices
class InvItem(BaseModel):
    packageName: str
    billingType: str = "One time"
    amount: float = 0
    discount: float = 0
    taxPercent: float = 0
    amcAmount: float = 0


class InvoiceIn(BaseModel):
    clinicId: Optional[int] = None
    clinicName: str
    clinicAddress: Optional[str] = None
    clinicMobile: Optional[str] = None
    billDate: dt.date
    items: List[InvItem]


def _d(v) -> Decimal:
    return Decimal(str(v or 0)).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)


def _calc(items: List[InvItem]):
    rows, tot = [], dict(a=Decimal(0), d=Decimal(0), t=Decimal(0), f=Decimal(0), m=Decimal(0))
    for i, it in enumerate(items):
        a, disc, pct, amc = _d(it.amount), _d(it.discount), _d(it.taxPercent), _d(it.amcAmount)
        tax = ((a - disc) * pct / 100).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
        fin = a - disc + tax
        bt = it.billingType if it.billingType in BILLING_TYPES else "One time"
        rows.append((it.packageName.strip()[:200], bt, a, disc, pct, tax, fin, amc, i))
        tot["a"] += a
        tot["d"] += disc
        tot["t"] += tax
        tot["f"] += fin
        tot["m"] += amc
    return rows, tot


def _save_invoice(uid, body: InvoiceIn, inv_id=None):
    if not body.clinicName.strip():
        raise HTTPException(400, "Select a clinic")
    if not body.items:
        raise HTTPException(400, "Select at least one package")
    rows, t = _calc(body.items)
    head = (
        body.clinicId, body.clinicName.strip(), (body.clinicAddress or "").strip(), (body.clinicMobile or "").strip(),
        body.billDate, t["a"], t["d"], t["t"], t["f"], t["m"],
    )
    with db.conn() as c:
        cur = c.cursor(as_dict=True)
        if inv_id is None:
            cur.execute(
                "INSERT INTO Invoices(UserId,ClinicId,ClinicName,ClinicAddress,ClinicMobile,BillDate,TotalAmount,TotalDiscount,TotalTax,TotalFinal,TotalAmc) "
                "OUTPUT INSERTED.Id VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)",
                (uid, *head),
            )
            inv_id = cur.fetchone()["Id"]
        else:
            cur.execute(
                "UPDATE Invoices SET ClinicId=%s,ClinicName=%s,ClinicAddress=%s,ClinicMobile=%s,BillDate=%s,TotalAmount=%s,TotalDiscount=%s,"
                "TotalTax=%s,TotalFinal=%s,TotalAmc=%s,UpdatedAt=SYSUTCDATETIME() WHERE Id=%s AND UserId=%s",
                (*head, inv_id, uid),
            )
            if cur.rowcount == 0:
                raise HTTPException(404, "Invoice not found")
            cur.execute("DELETE FROM InvoiceItems WHERE InvoiceId=%s", (inv_id,))
        for r in rows:
            cur.execute(
                "INSERT INTO InvoiceItems(InvoiceId,PackageName,BillingType,Amount,Discount,TaxPercent,TaxAmount,FinalAmount,AmcAmount,SortOrder) "
                "VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)",
                (inv_id, *r),
            )
    return get_invoice(inv_id, uid)


def _inv_out(r):
    return {
        "id": r["Id"], "clinicId": r["ClinicId"], "clinicName": r["ClinicName"], "clinicAddress": r["ClinicAddress"],
        "clinicMobile": r["ClinicMobile"], "billDate": r["BillDate"], "totalAmount": r["TotalAmount"], "totalDiscount": r["TotalDiscount"],
        "totalTax": r["TotalTax"], "totalFinal": r["TotalFinal"], "totalAmc": r["TotalAmc"], "updatedAt": r["UpdatedAt"],
    }


@app.get("/api/invoices")
def list_invoices(uid: int = Depends(current_user)):
    rows = db.query("SELECT * FROM Invoices WHERE UserId=%s ORDER BY BillDate DESC, Id DESC", (uid,))
    out = [_inv_out(r) for r in rows]
    if out:
        items = db.query(
            "SELECT i.InvoiceId,i.PackageName FROM InvoiceItems i JOIN Invoices v ON v.Id=i.InvoiceId WHERE v.UserId=%s ORDER BY i.SortOrder", (uid,)
        )
        by = defaultdict(list)
        for it in items:
            by[it["InvoiceId"]].append(it["PackageName"])
        for o in out:
            o["packages"] = by.get(o["id"], [])
    return out


@app.get("/api/invoices/{iid}")
def get_invoice(iid: int, uid: int = Depends(current_user)):
    r = db.query("SELECT * FROM Invoices WHERE Id=%s AND UserId=%s", (iid, uid), one=True)
    if not r:
        raise HTTPException(404, "Invoice not found")
    out = _inv_out(r)
    out["items"] = [
        {
            "packageName": i["PackageName"], "billingType": i["BillingType"], "amount": i["Amount"], "discount": i["Discount"],
            "taxPercent": i["TaxPercent"], "taxAmount": i["TaxAmount"], "finalAmount": i["FinalAmount"], "amcAmount": i["AmcAmount"],
        }
        for i in db.query("SELECT * FROM InvoiceItems WHERE InvoiceId=%s ORDER BY SortOrder", (iid,))
    ]
    return out


@app.post("/api/invoices")
def create_invoice(body: InvoiceIn, uid: int = Depends(current_user)):
    return _save_invoice(uid, body)


@app.put("/api/invoices/{iid}")
def update_invoice(iid: int, body: InvoiceIn, uid: int = Depends(current_user)):
    return _save_invoice(uid, body, iid)


@app.delete("/api/invoices/{iid}")
def delete_invoice(iid: int, uid: int = Depends(current_user)):
    db.execute("DELETE FROM Invoices WHERE Id=%s AND UserId=%s", (iid, uid))
    return {"ok": True}


# ---------------------------------------------------------------- static SPA
@app.exception_handler(HTTPException)
async def http_exc(request: Request, exc: HTTPException):
    return JSONResponse({"detail": exc.detail}, status_code=exc.status_code)


app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


@app.get("/health")
def health():
    return {"ok": True}


@app.get("/sw.js")
def service_worker():
    # Served from the root so its scope covers the whole app; never cached so updates roll out.
    return FileResponse(STATIC_DIR / "sw.js", media_type="application/javascript", headers={"Cache-Control": "no-cache"})


@app.get("/manifest.webmanifest")
def manifest():
    return FileResponse(STATIC_DIR / "manifest.webmanifest", media_type="application/manifest+json", headers={"Cache-Control": "no-cache"})


@app.get("/")
def index():
    return FileResponse(STATIC_DIR / "index.html", headers={"Cache-Control": "no-cache"})
