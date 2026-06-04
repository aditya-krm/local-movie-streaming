import { watch } from "fs";
import { join, basename, extname } from "path";
import { mkdir, exists, readdir, stat } from "fs/promises";

const RAW_DIR = "./raw_movies";
const OUTPUT_DIR = "./movies";

// --- HELPER: WAIT UNTIL FILE IS FULLY COPIED ---
async function waitUntilCopied(filePath: string): Promise<boolean> {
  let lastSize = -1;
  
  console.log(`[Waiting] ${basename(filePath)} is copying... holding off chunking.`);

  while (true) {
    try {
      if (!(await exists(filePath))) return false; // File was deleted/moved
      
      const stats = await stat(filePath);
      const currentSize = stats.size;

      // If the file size hasn't changed in 5 seconds, assume copying is done
      if (currentSize === lastSize && currentSize > 0) {
        break;
      }

      lastSize = currentSize;
      await Bun.sleep(5000); // Check every 5 seconds
    } catch (e) {
      // File might be locked by the OS copying process temporarily
      await Bun.sleep(2000);
    }
  }
  return true;
}

// --- HLS CHUNKER LOGIC ---
async function processMovie(filePath: string) {
  const fileName = basename(filePath);
  const ext = extname(fileName).toLowerCase();

  if (ext !== ".mp4" && ext !== ".mkv") return;

  const movieName = basename(filePath, ext).replace(/\s+/g, "_");
  const movieOutputDir = join(OUTPUT_DIR, movieName);

  // 1. Skip if already processed
  if (await exists(movieOutputDir)) {
    return;
  }

  // 2. Wait for large file transfers (20GB+) to finish
  const copyComplete = await waitUntilCopied(filePath);
  if (!copyComplete) return;

  console.log(`[Processing] Slicing ${fileName} into HLS chunks...`);
  await mkdir(movieOutputDir, { recursive: true });

  const process = Bun.spawn([
    "ffmpeg",
    "-i", filePath,
    "-codec", "copy",
    "-start_number", "0",
    "-hls_time", "10",
    "-hls_list_size", "0",
    "-f", "hls",
    join(movieOutputDir, "index.m3u8")
  ]);

  const exitCode = await process.exited;

  if (exitCode === 0) {
    console.log(`[Success] ${movieName} is ready for streaming!`);
  } else {
    console.error(`[Error] FFmpeg failed on ${fileName}`);
  }
}

// --- INITIAL SCAN (For existing movies on startup) ---
async function scanExistingMovies() {
  console.log("Scanning raw_movies for existing videos...");
  try {
    const files = await readdir(RAW_DIR);
    for (const file of files) {
      await processMovie(join(RAW_DIR, file));
    }
  } catch (err) {
    console.error("Could not scan raw_movies folder:", err);
  }
}

// --- FOLDER WATCHER (For newly dropped movies) ---
console.log(`Watching for movies in: ${RAW_DIR}`);
watch(RAW_DIR, async (eventType, filename) => {
  // We use "rename" because it triggers when a file is newly created/dropped in
  if (eventType === "rename" && filename) {
    const fullPath = join(RAW_DIR, filename);
    if (await exists(fullPath)) {
      // Let the processMovie handle the waiting loop
      processMovie(fullPath);
    }
  }
});

// Boot up sequence
await scanExistingMovies();

// --- HTTP SERVER LOGIC ---
Bun.serve({
  port: 3000,
  async fetch(req) {
    const url = new URL(req.url);
    const pathname = url.pathname;
    const headers = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
    };

    if (req.method === "OPTIONS") return new Response(null, { headers });

    if (pathname === "/movies" || pathname === "/movies/") {
      try {
        const dirs = await readdir(OUTPUT_DIR);
        const moviesList = dirs.map(dir => ({
          name: dir.replace(/_/g, " "),
          url: `http://${req.headers.get("host")}/movies/${dir}/index.m3u8`
        }));
        return Response.json(moviesList, { headers });
      } catch {
        return new Response("No movies found", { status: 404, headers });
      }
    }

    if (pathname.startsWith("/movies/")) {
      const filePath = join(".", decodeURIComponent(pathname)); 

      if (await exists(filePath)) {
        const file = Bun.file(filePath);
        let contentType = "application/octet-stream";
        if (pathname.endsWith(".m3u8")) contentType = "application/x-mpegURL";
        if (pathname.endsWith(".ts")) contentType = "video/MP2T";

        return new Response(file, { headers: { ...headers, "Content-Type": contentType } });
      }
    }

    return new Response("Not Found", { status: 404 });
  },
});

console.log("Streaming server running at http://localhost:3000");
