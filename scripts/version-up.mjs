import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");

const publicManifestPath = path.resolve(projectRoot, "public", "manifest.json");
const distManifestPath = path.resolve(projectRoot, "dist", "manifest.json");

if (!fs.existsSync(publicManifestPath)) {
  console.error(`Error: Manifest not found at ${publicManifestPath}`);
  process.exit(1);
}

function updateManifest(filePath) {
  const content = fs.readFileSync(filePath, "utf-8");
  const manifest = JSON.parse(content);

  const currentVersion = manifest.header?.version || [1, 0, 0];
  const newVersion = [
    Number(currentVersion[0] ?? 1),
    Number(currentVersion[1] ?? 0),
    Number(currentVersion[2] ?? 0) + 1,
  ];

  const oldName = manifest.header?.name || "";
  let newName = oldName;

  // 末尾のバージョン表記を検出してインクリメントしたバージョンに置換
  const commaVersionRegex = /\s*v?\d+\s*,\s*\d+\s*,\s*\d+$/;
  const dotVersionRegex = /\s*v?\d+\.\d+\.\d+$/;

  if (commaVersionRegex.test(oldName)) {
    // 例: "Step Assist Addon 1, 0, 4" -> "Step Assist Addon 1, 0, 5"
    newName = oldName.replace(commaVersionRegex, ` ${newVersion.join(", ")}`);
  } else if (dotVersionRegex.test(oldName)) {
    // 例: "Step Assist Addon 1.0.4" -> "Step Assist Addon 1.0.5"
    newName = oldName.replace(dotVersionRegex, ` ${newVersion.join(".")}`);
  } else {
    // バージョン表記が末尾にない場合はカンマ区切りで追加
    newName = `${oldName} ${newVersion.join(", ")}`.trim();
  }

  // header の更新
  manifest.header.version = newVersion;
  manifest.header.name = newName;

  // modules の version も header と同期
  if (Array.isArray(manifest.modules)) {
    for (const mod of manifest.modules) {
      mod.version = newVersion;
    }
  }

  fs.writeFileSync(filePath, JSON.stringify(manifest, null, 2) + "\n", "utf-8");

  return {
    oldVersion: currentVersion,
    newVersion,
    oldName,
    newName,
  };
}

function main() {
  console.log("Incrementing manifest.json version...");
  const result = updateManifest(publicManifestPath);

  // dist/manifest.json が存在する場合はそちらも同期
  if (fs.existsSync(distManifestPath)) {
    fs.copyFileSync(publicManifestPath, distManifestPath);
  }

  console.log(`✓ Name: "${result.oldName}" -> "${result.newName}"`);
  console.log(
    `✓ Version: [${result.oldVersion.join(", ")}] -> [${result.newVersion.join(", ")}]`
  );
  console.log("Successfully updated manifest.json!");
}

main();
