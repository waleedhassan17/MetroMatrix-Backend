"""MongoDB access for the batch jobs.

The jobs READ the platform's collections and WRITE only to `ml_*` collections.
`MlDatabase.ml()` refuses any other name, so a bug in a job cannot touch a
booking, an order or a wallet. In production the job's database user should
also be limited to read on source collections and readWrite on ml_* — this
guard is the second lock, not the only one.
"""
import os

from pymongo import MongoClient

ML_PREFIX = "ml_"


class MlDatabase:
    def __init__(self, db):
        self._db = db

    def src(self, name):
        """A source collection, for reading."""
        return self._db[name]

    def ml(self, name):
        """An ml_* collection, for writing."""
        if not name.startswith(ML_PREFIX):
            raise PermissionError(f"batch jobs may only write ml_* collections, not '{name}'")
        return self._db[name]


def connect(uri=None):
    uri = uri or os.environ.get("MONGODB_URI")
    if not uri:
        raise SystemExit("MONGODB_URI is not set")
    client = MongoClient(uri, serverSelectionTimeoutMS=15000, appname="metromatrix-ml")
    db = client.get_default_database(default=os.environ.get("MONGODB_DB", "metromatrix"))
    return MlDatabase(db)
