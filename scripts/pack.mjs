import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ZipArchive } from "archiver";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");
const distDir = path.resolve(projectRoot, "dist");
const outputDir = path.resolve(projectRoot, "output");

// 出力先ファイル名
const targetFileName = "dist.mcpack";
const rootOutputFile = path.resolve(projectRoot, targetFileName);
const dirOutputFile = path.resolve(outputDir, targetFileName);

if (!fs.existsSync(distDir)) {
  console.error("Error: 'dist' directory not found. Please run build first.");
  process.exit(1);
}

// output ディレクトリが存在しない場合は作成
if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir, { recursive: true });
}

async function createArchive(destinationPath) {
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(destinationPath);
    const archive = new ZipArchive({
      zlib: { level: 9 }, // 最高圧縮レベル
    });

    output.on("close", () => {
      resolve(archive.pointer());
    });

    archive.on("error", (err) => {
      reject(err);
    });

    archive.pipe(output);

    // dist ディレクトリの中身をアーカイブのルート直下に配置 (第2引数: false)
    archive.directory(distDir, false);

    archive.finalize();
  });
}

async function main() {
  console.log("Packaging dist files into .mcpack...");

  try {
    const bytes = await createArchive(rootOutputFile);
    const sizeKb = (bytes / 1024).toFixed(2);
    console.log(`✓ Created: ${path.relative(projectRoot, rootOutputFile)} (${sizeKb} KB)`);

    // output/ フォルダにも複製
    fs.copyFileSync(rootOutputFile, dirOutputFile);
    console.log(`✓ Copied to: ${path.relative(projectRoot, dirOutputFile)}`);

    console.log("Successfully created .mcpack artifact!");
  } catch (error) {
    console.error("Failed to create package:", error);
    process.exit(1);
  }
}

main();
