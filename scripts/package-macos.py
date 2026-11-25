"""Assemble and ad-hoc sign macOS bundles on a POSIX build host."""

import argparse
import hashlib
import json
import os
import plistlib
import shutil
import stat
import struct
import subprocess
import tempfile
import zipfile
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
RELEASE = ROOT / "tmp" / "mac-release"
DOWNLOADS = RELEASE / "downloads"
NAME = "OE DESK"
BUNDLE_ID = "com.oestudiomacau.oedesk"


def unpack_runtime(runtime: Path, stage: Path):
    sums = (DOWNLOADS / "electron-SHASUMS256.txt").read_text().splitlines()
    expected = next(line.split()[0] for line in sums if line.split()[-1].lstrip("*") == runtime.name)
    with runtime.open("rb") as source:
        if hashlib.file_digest(source, "sha256").hexdigest() != expected:
            raise ValueError(f"Checksum mismatch for {runtime.name}")
    with zipfile.ZipFile(runtime) as archive:
        for entry in archive.infolist():
            output = stage / entry.filename
            if not output.resolve().is_relative_to(stage):
                raise ValueError("Unexpected entry outside the runtime bundle")
            mode = entry.external_attr >> 16
            if entry.is_dir():
                output.mkdir(parents=True, exist_ok=True)
            else:
                output.parent.mkdir(parents=True, exist_ok=True)
                if stat.S_ISLNK(mode):
                    output.symlink_to(archive.read(entry).decode())
                else:
                    with archive.open(entry) as source, output.open("wb") as destination:
                        shutil.copyfileobj(source, destination)
                    if mode:
                        output.chmod(stat.S_IMODE(mode))


def rename_bundle(bundle: Path, name: str, identifier: str, app_version: str | None = None):
    info_path = bundle / "Contents" / "Info.plist"
    document = plistlib.loads(info_path.read_bytes())
    executable = bundle / "Contents" / "MacOS" / document.get("CFBundleExecutable", bundle.stem)
    executable.rename(executable.with_name(name))
    document.update(CFBundleName=name, CFBundleDisplayName=name, CFBundleExecutable=name, CFBundleIdentifier=identifier)
    if app_version:
        document.update(CFBundleVersion=app_version, CFBundleShortVersionString=app_version)
        document.pop("ElectronAsarIntegrity", None)
    info_path.write_bytes(plistlib.dumps(document))


def add_app(bundle: Path, lock: dict, payload: Path | None):
    resources = bundle / "Contents" / "Resources"
    (resources / "default_app.asar").unlink(missing_ok=True)
    app = resources / "app"
    app.mkdir()
    for filename in ("index.html", "server.js"):
        shutil.copy2(ROOT / filename, app)
    for directory in ("client", "electron", "rpa", "server"):
        shutil.copytree(ROOT / directory, app / directory)
    helper = Path("web-chat/backend/answer-basis.mjs")
    (app / helper).parent.mkdir(parents=True)
    shutil.copy2(ROOT / helper, app / helper)
    package = lock["packages"][""]
    (app / "package.json").write_text(json.dumps({
        "name": package["name"], "version": package["version"], "productName": NAME,
        "type": "module", "main": "electron/main.cjs", "private": True,
    }), encoding="utf-8")
    for relative, metadata in lock["packages"].items():
        if relative.startswith("node_modules/") and not metadata.get("dev"):
            shutil.copytree(ROOT / relative, app / relative, dirs_exist_ok=True)
    if payload:
        shutil.copy2(payload, resources / "oe-desk-profile.bin")


def archive_bundle(bundle: Path, output: Path):
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
        for directory, subdirs, files in os.walk(bundle, followlinks=False):
            entries = [Path(directory) / name for name in sorted(subdirs + files)]
            for path in entries:
                relative = path.relative_to(bundle.parent).as_posix()
                if path.is_symlink():
                    entry = zipfile.ZipInfo(relative)
                    entry.create_system = 3
                    entry.external_attr = (stat.S_IFLNK | 0o777) << 16
                    archive.writestr(entry, os.readlink(path))
                else:
                    archive.write(path, relative)


def verify_main_signature(bundle: Path, arch: str):
    contents = bundle / "Contents"
    binary = (contents / "MacOS" / NAME).read_bytes()
    magic, target, _, _, commands = struct.unpack_from("<5I", binary)
    if magic != 0xFEEDFACF or target != {"arm64": 0x0100000C, "x64": 0x01000007}[arch]:
        raise ValueError("Incorrect macOS executable architecture")
    cursor = 32
    offset = 0
    for _ in range(commands):
        command, size = struct.unpack_from("<2I", binary, cursor)
        if command == 0x1D:  # LC_CODE_SIGNATURE
            offset, length = struct.unpack_from("<2I", binary, cursor + 8)
            break
        cursor += size
    if not offset:
        raise ValueError("Missing Mach-O code signature")
    signature = binary[offset:offset + length]
    magic, _, count = struct.unpack_from(">3I", signature)
    if magic != 0xFADE0CC0:
        raise ValueError("Invalid code signature container")
    slots = dict(struct.unpack_from(">2I", signature, 12 + index * 8) for index in range(count))
    code = signature[slots[0]:]
    magic, _, _, flags, hashes, _, special, pages, limit = struct.unpack_from(">9I", code)
    size, algorithm, _, page_shift = struct.unpack_from(">4B", code, 36)
    if magic != 0xFADE0C02 or not (flags & 2) or limit != offset or special < 3:
        raise ValueError("Incomplete ad-hoc code directory")
    digest = {1: hashlib.sha1, 2: hashlib.sha256, 3: hashlib.sha256, 4: hashlib.sha384}[algorithm]
    page_size = 1 << page_shift
    if pages != (limit + page_size - 1) // page_size:
        raise ValueError("Incorrect code signature page count")
    for index in range(pages):
        start = hashes + index * size
        page = binary[index * page_size:min((index + 1) * page_size, limit)]
        if digest(page).digest()[:size] != code[start:start + size]:
            raise ValueError(f"Code signature failed for page {index}")
    for index, file in ((1, contents / "Info.plist"), (3, contents / "_CodeSignature" / "CodeResources")):
        start = hashes - index * size
        if digest(file.read_bytes()).digest()[:size] != code[start:start + size]:
            raise ValueError(f"Code signature failed for {file.name}")


def build(args):
    lock = json.loads((ROOT / "package-lock.json").read_text(encoding="utf-8"))
    version = lock["version"]
    runtime_version = lock["packages"]["node_modules/electron"]["version"]
    runtime = DOWNLOADS / f"electron-v{runtime_version}-darwin-{args.arch}.zip"
    flavor = "Private-" if args.profile else ""
    output = RELEASE / f"OE-DESK-{flavor}{version}-macOS-{args.arch}.zip"
    with tempfile.TemporaryDirectory(prefix="oedesk-macos-") as work:
        stage = Path(work).resolve()
        unpack_runtime(runtime, stage)
        bundle = stage / f"{NAME}.app"
        (stage / "Electron.app").rename(bundle)
        rename_bundle(bundle, NAME, BUNDLE_ID, version)
        for helper in sorted((bundle / "Contents" / "Frameworks").glob("Electron Helper*.app")):
            helper_name = NAME + helper.stem[len("Electron"):]
            info = plistlib.loads((helper / "Contents" / "Info.plist").read_bytes())
            suffix = info["CFBundleIdentifier"].split(".helper", 1)[-1]
            rename_bundle(helper, helper_name, BUNDLE_ID + ".helper" + suffix)
            helper.rename(helper.with_name(helper_name + ".app"))
        add_app(bundle, lock, args.profile)
        for license_file in ("LICENSE", "LICENSES.chromium.html"):
            if (stage / license_file).is_file():
                shutil.copy2(stage / license_file, bundle / "Contents" / "Resources" / license_file)
        subprocess.run([str(args.rcodesign.resolve()), "sign", str(bundle)], check=True)
        verify_main_signature(bundle, args.arch)
        pending = output.with_suffix(".pending")
        try:
            archive_bundle(bundle, pending)
            pending.replace(output)
        finally:
            pending.unlink(missing_ok=True)
    print(output, flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("arch", choices=("arm64", "x64"))
    parser.add_argument("--rcodesign", type=Path, required=True)
    parser.add_argument("--profile", type=Path)
    build(parser.parse_args())
