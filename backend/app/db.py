"""SQL Server access (pymssql) with a tiny connection pool and idempotent schema setup."""
import os
import queue
import threading
import time
from contextlib import contextmanager

import pymssql

_POOL: "queue.LifoQueue[pymssql.Connection]" = queue.LifoQueue(maxsize=10)
_LOCK = threading.Lock()


def _connect():
    return pymssql.connect(
        server=os.environ["DB_SERVER"],
        port=os.environ.get("DB_PORT", "1433"),
        user=os.environ["DB_USER"],
        password=os.environ["DB_PASSWORD"],
        database=os.environ.get("DB_NAME", "T_Map"),
        login_timeout=15,
        timeout=60,
        charset="UTF-8",
        autocommit=False,
    )


@contextmanager
def conn():
    """Yield a pooled connection; commits on success, rolls back on error."""
    try:
        c, last = _POOL.get_nowait()
    except queue.Empty:
        c, last = _connect(), time.time()
    ok = False
    try:
        # liveness check only for connections idle for a while (saves a round trip)
        if time.time() - last > 120:
            try:
                cur = c.cursor()
                cur.execute("SELECT 1")
                cur.fetchall()
            except Exception:
                try:
                    c.close()
                except Exception:
                    pass
                c = _connect()
        yield c
        c.commit()
        ok = True
    finally:
        if ok:
            try:
                _POOL.put_nowait((c, time.time()))
            except queue.Full:
                c.close()
        else:
            try:
                c.rollback()
                _POOL.put_nowait((c, time.time()))
            except Exception:
                try:
                    c.close()
                except Exception:
                    pass


def query(sql, params=None, one=False):
    with conn() as c:
        cur = c.cursor(as_dict=True)
        cur.execute(sql, params or ())
        rows = cur.fetchall()
        return (rows[0] if rows else None) if one else rows


def execute(sql, params=None):
    """Execute and return the first row of any OUTPUT/SELECT result (or None)."""
    with conn() as c:
        cur = c.cursor(as_dict=True)
        cur.execute(sql, params or ())
        try:
            return cur.fetchone()
        except pymssql.OperationalError:
            return None


SCHEMA = [
    """IF OBJECT_ID('dbo.Users') IS NULL CREATE TABLE dbo.Users(
        Id INT IDENTITY PRIMARY KEY,
        Username NVARCHAR(100) NOT NULL UNIQUE,
        PasswordHash NVARCHAR(200) NOT NULL,
        FullName NVARCHAR(200) NULL,
        CreatedAt DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME())""",
    """IF OBJECT_ID('dbo.Projects') IS NULL CREATE TABLE dbo.Projects(
        Id INT IDENTITY PRIMARY KEY,
        UserId INT NOT NULL REFERENCES dbo.Users(Id),
        Name NVARCHAR(200) NOT NULL,
        WebsiteUrl NVARCHAR(500) NULL,
        AttachmentName NVARCHAR(300) NULL,
        AttachmentPath NVARCHAR(500) NULL,
        AttachmentMime NVARCHAR(150) NULL,
        CreatedAt DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
        UpdatedAt DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME())""",
    """IF OBJECT_ID('dbo.Customers') IS NULL CREATE TABLE dbo.Customers(
        Id INT IDENTITY PRIMARY KEY,
        UserId INT NOT NULL REFERENCES dbo.Users(Id),
        Name NVARCHAR(200) NOT NULL,
        Mobile NVARCHAR(30) NOT NULL,
        CreatedAt DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME())""",
    """IF OBJECT_ID('dbo.ShareLinks') IS NULL CREATE TABLE dbo.ShareLinks(
        Token NVARCHAR(64) NOT NULL PRIMARY KEY,
        UserId INT NOT NULL REFERENCES dbo.Users(Id),
        ProjectId INT NOT NULL REFERENCES dbo.Projects(Id) ON DELETE CASCADE,
        CustomerId INT NULL,
        ExpiresAt DATETIME2 NOT NULL,
        CreatedAt DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME())""",
    """IF OBJECT_ID('dbo.Visits') IS NULL CREATE TABLE dbo.Visits(
        Id INT IDENTITY PRIMARY KEY,
        UserId INT NOT NULL REFERENCES dbo.Users(Id),
        ClinicName NVARCHAR(200) NOT NULL,
        DoctorName NVARCHAR(200) NULL,
        VisitDate DATE NOT NULL,
        FollowUpDate DATE NULL,
        ReferralDoctor NVARCHAR(200) NULL,
        PersonMet NVARCHAR(200) NULL,
        Notes NVARCHAR(MAX) NULL,
        Status NVARCHAR(40) NOT NULL DEFAULT 'Visited',
        Latitude FLOAT NULL,
        Longitude FLOAT NULL,
        LocationText NVARCHAR(500) NULL,
        IsDeleted BIT NOT NULL DEFAULT 0,
        CreatedAt DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
        UpdatedAt DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME())""",
    """IF OBJECT_ID('dbo.VisitImages') IS NULL CREATE TABLE dbo.VisitImages(
        Id INT IDENTITY PRIMARY KEY,
        VisitId INT NOT NULL REFERENCES dbo.Visits(Id),
        UserId INT NOT NULL REFERENCES dbo.Users(Id),
        FileName NVARCHAR(300) NOT NULL,
        FilePath NVARCHAR(500) NOT NULL,
        Mime NVARCHAR(150) NULL,
        CreatedAt DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME())""",
    """IF OBJECT_ID('dbo.Clinics') IS NULL CREATE TABLE dbo.Clinics(
        Id INT IDENTITY PRIMARY KEY,
        UserId INT NOT NULL REFERENCES dbo.Users(Id),
        Name NVARCHAR(200) NOT NULL,
        Address NVARCHAR(600) NULL,
        Mobile NVARCHAR(60) NULL,
        CreatedAt DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME())""",
    """IF OBJECT_ID('dbo.Packages') IS NULL CREATE TABLE dbo.Packages(
        Id INT IDENTITY PRIMARY KEY,
        UserId INT NOT NULL REFERENCES dbo.Users(Id),
        Name NVARCHAR(200) NOT NULL,
        SortOrder INT NOT NULL DEFAULT 0,
        IsDeleted BIT NOT NULL DEFAULT 0)""",
    """IF OBJECT_ID('dbo.Invoices') IS NULL CREATE TABLE dbo.Invoices(
        Id INT IDENTITY PRIMARY KEY,
        UserId INT NOT NULL REFERENCES dbo.Users(Id),
        ClinicId INT NULL,
        ClinicName NVARCHAR(200) NOT NULL,
        ClinicAddress NVARCHAR(600) NULL,
        ClinicMobile NVARCHAR(60) NULL,
        BillDate DATE NOT NULL,
        TotalAmount DECIMAL(14,2) NOT NULL DEFAULT 0,
        TotalDiscount DECIMAL(14,2) NOT NULL DEFAULT 0,
        TotalTax DECIMAL(14,2) NOT NULL DEFAULT 0,
        TotalFinal DECIMAL(14,2) NOT NULL DEFAULT 0,
        TotalAmc DECIMAL(14,2) NOT NULL DEFAULT 0,
        CreatedAt DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
        UpdatedAt DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME())""",
    """IF OBJECT_ID('dbo.InvoiceItems') IS NULL CREATE TABLE dbo.InvoiceItems(
        Id INT IDENTITY PRIMARY KEY,
        InvoiceId INT NOT NULL REFERENCES dbo.Invoices(Id) ON DELETE CASCADE,
        PackageName NVARCHAR(200) NOT NULL,
        BillingType NVARCHAR(30) NOT NULL,
        Amount DECIMAL(14,2) NOT NULL DEFAULT 0,
        Discount DECIMAL(14,2) NOT NULL DEFAULT 0,
        TaxPercent DECIMAL(6,2) NOT NULL DEFAULT 0,
        TaxAmount DECIMAL(14,2) NOT NULL DEFAULT 0,
        FinalAmount DECIMAL(14,2) NOT NULL DEFAULT 0,
        AmcAmount DECIMAL(14,2) NOT NULL DEFAULT 0,
        SortOrder INT NOT NULL DEFAULT 0)""",
    "IF COL_LENGTH('dbo.Customers','Url') IS NULL ALTER TABLE dbo.Customers ADD Url NVARCHAR(500) NULL",
    "IF COL_LENGTH('dbo.Customers','ContactPerson') IS NULL ALTER TABLE dbo.Customers ADD ContactPerson NVARCHAR(200) NULL",
    "IF COL_LENGTH('dbo.Customers','StartDate') IS NULL ALTER TABLE dbo.Customers ADD StartDate DATE NULL",
    "IF COL_LENGTH('dbo.Customers','EndDate') IS NULL ALTER TABLE dbo.Customers ADD EndDate DATE NULL",
    "IF COL_LENGTH('dbo.Customers','Duration') IS NULL ALTER TABLE dbo.Customers ADD Duration NVARCHAR(100) NULL",
    "IF COL_LENGTH('dbo.Customers','Address') IS NULL ALTER TABLE dbo.Customers ADD Address NVARCHAR(600) NULL",
    """IF OBJECT_ID('dbo.Durations') IS NULL CREATE TABLE dbo.Durations(
        Id INT IDENTITY PRIMARY KEY,
        UserId INT NOT NULL REFERENCES dbo.Users(Id),
        Name NVARCHAR(100) NOT NULL,
        Months INT NULL,
        SortOrder INT NOT NULL DEFAULT 0,
        IsDeleted BIT NOT NULL DEFAULT 0)""",
    # small per-user editable lists (Near Me categories and distances)
    """IF OBJECT_ID('dbo.Lookups') IS NULL CREATE TABLE dbo.Lookups(
        Id INT IDENTITY PRIMARY KEY,
        UserId INT NOT NULL REFERENCES dbo.Users(Id),
        Kind NVARCHAR(30) NOT NULL,
        Name NVARCHAR(100) NOT NULL,
        Value NVARCHAR(300) NULL,
        SortOrder INT NOT NULL DEFAULT 0,
        IsDeleted BIT NOT NULL DEFAULT 0)""",
    """IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='IX_Visits_User')
        CREATE INDEX IX_Visits_User ON dbo.Visits(UserId, IsDeleted, VisitDate)""",
]


def init_schema():
    with conn() as c:
        cur = c.cursor()
        for stmt in SCHEMA:
            cur.execute(stmt)
