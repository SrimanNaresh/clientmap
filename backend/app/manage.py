"""Admin helper.  Inside the container:
    docker exec -it clientmap-app python -m app.manage add-user <username> <password> [full name]
    docker exec -it clientmap-app python -m app.manage set-password <username> <password>
"""
import sys

import bcrypt

from . import db


def main(argv):
    if len(argv) < 3 or argv[0] not in ("add-user", "set-password"):
        sys.exit(__doc__)
    h = bcrypt.hashpw(argv[2].encode(), bcrypt.gensalt()).decode()
    if argv[0] == "add-user":
        db.execute("INSERT INTO Users(Username,PasswordHash,FullName) VALUES(%s,%s,%s)", (argv[1], h, " ".join(argv[3:]) or argv[1]))
    else:
        db.execute("UPDATE Users SET PasswordHash=%s WHERE Username=%s", (h, argv[1]))
    print("done")


if __name__ == "__main__":
    main(sys.argv[1:])
