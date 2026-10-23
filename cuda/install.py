"""Private wheel extraction. No pip, registry, PATH or system Python changes."""
import pathlib
import sys
import zipfile


def extract(archive, target):
    target = pathlib.Path(target).resolve()
    with zipfile.ZipFile(archive) as z:
        for item in z.infolist():
            if item.is_dir():
                continue
            name = item.filename.replace("\\", "/")
            destination = (target / name).resolve()
            if not destination.is_relative_to(target) or ":" in name:
                raise ValueError("Unsafe archive path")
            if ".data/" in name:
                _, scheme, relative = name.split("/", 2)
                if scheme not in ("purelib", "platlib"):
                    continue
                destination = (target / relative).resolve()
                if not destination.is_relative_to(target):
                    raise ValueError("Unsafe wheel path")
                destination.parent.mkdir(parents=True, exist_ok=True)
                if not item.is_dir():
                    destination.write_bytes(z.read(item))
            else:
                z.extract(item, target)


if __name__ == "__main__":
    for archive in sys.argv[2:]:
        extract(archive, sys.argv[1])
