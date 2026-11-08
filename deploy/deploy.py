"""Deploy ClientMap to the VPS with paramiko.

Usage:  python deploy/deploy.py
Reads SSH settings from deploy/deploy.env (DEPLOY_HOST, DEPLOY_USER, DEPLOY_PASSWORD).
Uploads backend/, docker-compose.yml and the nginx site, backs up the previous
release (data/ uploads are kept), rebuilds the container and reloads nginx.
"""
import io
import os
import sys
import tarfile
import time
from pathlib import Path

import paramiko

ROOT = Path(__file__).resolve().parent.parent
REMOTE = "/opt/projects/clientmap"
SITE = "clientmap.conf"


def load_env(p: Path):
    env = {}
    for line in p.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            env[k.strip()] = v.strip()
    return env


def build_tar() -> bytes:
    buf = io.BytesIO()
    skip = {"__pycache__", "data", ".pytest_cache"}
    with tarfile.open(fileobj=buf, mode="w:gz") as tar:
        def add(path: Path, arc: str):
            if path.is_dir():
                for child in sorted(path.iterdir()):
                    if child.name in skip:
                        continue
                    add(child, f"{arc}/{child.name}")
            else:
                tar.add(path, arcname=arc)
        add(ROOT / "backend", "backend")
        add(ROOT / "docker-compose.yml", "docker-compose.yml")
        add(ROOT / "deploy" / "nginx-clientmap.conf", "deploy/nginx-clientmap.conf")
    return buf.getvalue()


def run(ssh, cmd, check=True):
    print(f"$ {cmd}")
    _, out, err = ssh.exec_command(cmd, timeout=900)
    code = out.channel.recv_exit_status()
    o, e = out.read().decode(errors="replace"), err.read().decode(errors="replace")
    if o.strip():
        print(o.rstrip()[-4000:])
    if e.strip():
        print(e.rstrip()[-4000:])
    if check and code != 0:
        sys.exit(f"command failed ({code}): {cmd}")
    return code, o


def main():
    cfg = load_env(ROOT / "deploy" / "deploy.env")
    if not (ROOT / "backend" / ".env").exists():
        sys.exit("backend/.env is missing")
    ssh = paramiko.SSHClient()
    ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    ssh.connect(cfg["DEPLOY_HOST"], username=cfg["DEPLOY_USER"], password=cfg["DEPLOY_PASSWORD"], timeout=30)

    stamp = time.strftime("%Y%m%d-%H%M%S")
    run(ssh, f"mkdir -p {REMOTE}/data/uploads")
    code, _ = run(ssh, f"test -f {REMOTE}/docker-compose.yml", check=False)
    if code == 0:
        run(ssh, f"cd /opt/projects && tar czf clientmap-backup-{stamp}.tgz --exclude=clientmap/data clientmap")

    sftp = ssh.open_sftp()
    tmp = f"/tmp/clientmap-{stamp}.tgz"
    sftp.putfo(io.BytesIO(build_tar()), tmp)
    run(ssh, f"rm -rf {REMOTE}/backend && tar xzf {tmp} -C {REMOTE} && rm -f {tmp}")
    sftp.put(str(ROOT / "backend" / ".env"), f"{REMOTE}/backend/.env")
    sftp.close()
    run(ssh, f"chmod 600 {REMOTE}/backend/.env")

    run(ssh, f"cd {REMOTE} && docker compose up -d --build 2>&1 | tail -20")

    # nginx site (exact server_name; does not touch other sites)
    run(ssh, f"cp {REMOTE}/deploy/nginx-clientmap.conf /etc/nginx/sites-available/{SITE} && "
             f"ln -sf /etc/nginx/sites-available/{SITE} /etc/nginx/sites-enabled/{SITE}")
    code, _ = run(ssh, "nginx -t", check=False)
    if code != 0:
        run(ssh, f"rm -f /etc/nginx/sites-enabled/{SITE}", check=False)
        sys.exit("nginx config test failed - site disabled, nginx not reloaded")
    run(ssh, "systemctl reload nginx")

    for _ in range(30):
        code, out = run(ssh, "curl -fsS http://127.0.0.1:5130/health", check=False)
        if code == 0:
            break
        time.sleep(3)
    else:
        run(ssh, "docker logs --tail 60 clientmap-app", check=False)
        sys.exit("app did not become healthy")
    run(ssh, "curl -s -o /dev/null -w 'public https: %{http_code}\\n' --resolve clientmap.thangaminfotech.com:443:127.0.0.1 https://clientmap.thangaminfotech.com/", check=False)
    ssh.close()
    print("Deployed: https://clientmap.thangaminfotech.com")


if __name__ == "__main__":
    main()
