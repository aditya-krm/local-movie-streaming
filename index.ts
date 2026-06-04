import { watch } from "fs";
import { join, basename, extname } from "path";
import { mkdir, exists } from "fs/promises";

const RAW_DIR = "./raw_movies";
const OUTPUT_DIR = "./movies";

// --- HLS CHUNKER LOGIC ---

async function processMovie(filePath: string) {
  const fileName = basename(filePath);
  const ext = extname(fileName).toLowerCase();

  // Only process video files
  if (ext !== ".mp4" && ext !== ".mkv") return;

  const movieName = basename(filePath, ext).replace(/\s+/g, "_"); // Replace spaces for clean URLs
  const movieOutputDir = join(OUTPUT_DIR, movieName);

  // Skip if already processed
  if (await exists(movieOutputDir)) {
    console.log(`[Skipped] ${movieName} already exists.`);
    return;
  }

  console.log(`[Processing] Slicing ${fileName} into HLS chunks...`);
  await mkdir(movieOutputDir, { recursive: true });

  // Run FFmpeg using Bun's built-in Bun.spawn
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

  // Wait for FFmpeg to finish
  const exitCode = await process.exited;

  if (exitCode === 0) {
    console.log(`[Success] ${movieName} is ready for streaming!`);
  } else {
    console.error(`[Error] FFmpeg failed on ${fileName}`);
  }
}

// Watch the raw_movies folder for new files
console.log(`Watching for movies in: ${RAW_DIR}`);
watch(RAW_DIR, async (eventType, filename) => {
  if (eventType === "rename" && filename) {
    const fullPath = join(RAW_DIR, filename);
    // Add a small delay to ensure file copying is finished before processing
    if (await exists(fullPath)) {
      setTimeout(() => processMovie(fullPath), 1000);
    }
  }
});

// --- HTTP SERVER LOGIC ---

Bun.serve({
  port: 3000,
  async fetch(req) {
    const url = new URL(req.url);
    const pathname = url.pathname;

    // CORS Headers for local streaming players
    const headers = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
    };

    if (req.method === "OPTIONS") {
      return new Response(null, { headers });
    }

    // Endpoint to list all available streams
    if (pathname === "/movies" || pathname === "/movies/") {
      try {
        const { readdir } = require("fs/promises");
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

    // Serve the HLS (.m3u8 and .ts) files dynamically
    if (pathname.startsWith("/movies/")) {
      // Decode URL to handle special characters safely
      const filePath = join(".", decodeURIComponent(pathname)); 

      if (await exists(filePath)) {
        const file = Bun.file(filePath);
        
        // Set correct Content-Type for HLS
        let contentType = "application/octet-stream";
        if (pathname.endsWith(".m3u8")) contentType = "application/x-mpegURL";
        if (pathname.endsWith(".ts")) contentType = "video/MP2T";

        return new Response(file, {
          headers: {
            ...headers,
            "Content-Type": contentType,
          },
        });
      }
    }

    return new Response("Not Found", { status: 404 });
  },
});

console.log("Streaming server running at http://localhost:3000");
