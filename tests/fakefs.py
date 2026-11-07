"""Tiny in-memory stand-in for the parts of the Firestore client we use."""


class Snap:
    def __init__(self, ref, d):
        self.reference = ref
        self.id = ref.id
        self._d = d
        self.exists = d is not None

    def to_dict(self):
        return dict(self._d) if self._d is not None else None


class Doc:
    def __init__(self, db, path):
        self.db, self.path = db, path
        self.id = path.split("/")[-1]
        self.parent = Coll(db, path.rsplit("/", 1)[0])

    def get(self):
        return Snap(self, self.db.store.get(self.path))

    def set(self, d, merge=False):
        self.db.store[self.path] = {**(self.db.store.get(self.path) or {}), **d} if merge else dict(d)

    def delete(self):
        self.db.store.pop(self.path, None)

    def collection(self, name):
        return Coll(self.db, f"{self.path}/{name}")


class Coll:
    def __init__(self, db, path):
        self.db, self.path = db, path
        self.id = path.split("/")[-1]

    @property
    def parent(self):
        return Doc(self.db, self.path.rsplit("/", 1)[0]) if "/" in self.path else None

    def document(self, did):
        return Doc(self.db, f"{self.path}/{did}")


class FakeDB:
    def __init__(self, store=None):
        self.store = dict(store or {})

    def collection(self, name):
        return Coll(self, name)

    def collection_group(self, name):
        db = self

        class Group:
            def stream(self_inner):
                for path, d in list(db.store.items()):
                    parts = path.split("/")
                    if len(parts) >= 2 and parts[-2] == name:
                        yield Snap(Doc(db, path), d)

        return Group()
