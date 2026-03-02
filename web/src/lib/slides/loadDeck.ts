import fs from "node:fs/promises";
import path from "node:path";

import { slidesImagesRoot, slidesRoot } from "@/lib/fs/paths";
import { slideDeckSchema, type SlideDeck } from "@/lib/slides/types";

export async function loadSlideDeck(): Promise<SlideDeck | null> {
  try {
    const jsonFiles = await collectJsonFiles(slidesRoot);
    if (jsonFiles.length) {
      const sortedFiles = jsonFiles.sort((a, b) => a.localeCompare(b));
      const parsedDecks: SlideDeck[] = [];

      for (const filePath of sortedFiles) {
        try {
          const raw = await fs.readFile(filePath, "utf8");
          const parsed = JSON.parse(raw) as unknown;
          const deck = slideDeckSchema.safeParse(parsed);
          if (deck.success) {
            parsedDecks.push(deck.data);
          }
        } catch {
          continue;
        }
      }

      if (parsedDecks.length) {
        const firstDeck = parsedDecks[0];
        const modules = parsedDecks.flatMap((deck) =>
          deck.modules.map((module) => ({
            ...module,
            title: normalizeSlideTitle(module.title),
            source_deck: deck.deck_title,
          })),
        );

        return {
          deck_title: parsedDecks.length === 1 ? firstDeck.deck_title : "Combined Walkthrough Deck",
          version: firstDeck.version,
          updated_at: new Date().toISOString(),
          modules,
        };
      }
    }

    return await loadDeckFromMarkdownFallback();
  } catch {
    return null;
  }
}

async function loadDeckFromMarkdownFallback(): Promise<SlideDeck | null> {
  const markdownFiles = await collectMarkdownFiles(slidesRoot);
  const filteredFiles = markdownFiles.filter((filePath) => {
    const normalized = filePath.replaceAll("\\", "/").toLowerCase();
    const filename = path.basename(filePath).toLowerCase();
    if (filename === "speaker_script.md") {
      return false;
    }
    if (normalized.includes("/speaker_script/")) {
      return false;
    }
    return true;
  });

  if (!filteredFiles.length) {
    return null;
  }

  const modules = await Promise.all(
    filteredFiles
      .sort((a, b) => markdownModuleSortKey(a).localeCompare(markdownModuleSortKey(b), undefined, { numeric: true, sensitivity: "base" }))
      .map((filePath, index) => markdownFileToModule(filePath, index + 1)),
  );

  return {
    deck_title: "Markdown Slides Deck",
    version: "1.0",
    updated_at: new Date().toISOString(),
    modules,
  };
}

async function markdownFileToModule(filePath: string, position: number): Promise<SlideDeck["modules"][number]> {
  const markdown = await fs.readFile(filePath, "utf8");
  const lines = markdown
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const headingLine = lines.find((line) => line.startsWith("#"));
  const title =
    headingLine?.replace(/^#{1,6}\s+/, "").trim() ||
    path.basename(filePath, path.extname(filePath)).replace(/[_-]+/g, " ");

  const bulletItems = lines
    .filter((line) => /^(\*|-)\s+/.test(line))
    .map((line) => line.replace(/^(\*|-)\s+/, "").trim())
    .slice(0, 8);

  const bodyText = lines
    .filter((line) => !line.startsWith("#") && !/^(\*|-)\s+/.test(line))
    .join(" ")
    .slice(0, 600);

  return {
    slide: String(position),
    title: normalizeSlideTitle(title),
    source_deck: path.basename(path.dirname(filePath)) || "Slides",
    subtitle: "",
    list_description: title,
    speaker_notes: "",
    sections: [
      bulletItems.length
        ? {
            type: "bullets",
            title: "Overview",
            items: bulletItems,
            urls: [],
          }
        : {
            type: "text",
            title: "Overview",
            items: [],
            urls: [],
            text: bodyText || " ",
          },
    ],
    images: [],
  };
}

async function collectJsonFiles(root: string): Promise<string[]> {
  const results: string[] = [];
  const queue = [root];

  while (queue.length) {
    const current = queue.shift();
    if (!current) {
      continue;
    }

    try {
      const entries = await fs.readdir(current, { withFileTypes: true });
      for (const entry of entries) {
        const absolutePath = path.join(current, entry.name);
        if (entry.isDirectory()) {
          queue.push(absolutePath);
          continue;
        }

        if (entry.isFile() && entry.name.toLowerCase().endsWith(".json")) {
          results.push(absolutePath);
        }
      }
    } catch {
      continue;
    }
  }

  return results;
}

async function collectMarkdownFiles(root: string): Promise<string[]> {
  const results: string[] = [];
  const queue = [root];

  while (queue.length) {
    const current = queue.shift();
    if (!current) {
      continue;
    }

    try {
      const entries = await fs.readdir(current, { withFileTypes: true });
      for (const entry of entries) {
        const absolutePath = path.join(current, entry.name);
        if (entry.isDirectory()) {
          queue.push(absolutePath);
          continue;
        }

        if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
          results.push(absolutePath);
        }
      }
    } catch {
      continue;
    }
  }

  return results;
}

function markdownModuleSortKey(filePath: string): string {
  const parent = path.basename(path.dirname(filePath)).toLowerCase();
  const file = path.basename(filePath).toLowerCase();
  return `${parent}/${file}`;
}

function normalizeSlideTitle(title: string): string {
  return title.replace(/^slide\s+\d+\s*:\s*/i, "").trim();
}

export async function resolveSlideImage(
  imageName: string,
): Promise<{ absolutePath: string; contentType: string } | null> {
  const safeName = path.basename(imageName);
  const absolutePath = path.join(slidesImagesRoot, safeName);

  try {
    const stat = await fs.stat(absolutePath);
    if (!stat.isFile()) {
      return null;
    }
  } catch {
    return null;
  }

  const ext = path.extname(safeName).toLowerCase();
  const contentType =
    ext === ".png"
      ? "image/png"
      : ext === ".jpg" || ext === ".jpeg"
        ? "image/jpeg"
        : ext === ".webp"
          ? "image/webp"
          : ext === ".gif"
            ? "image/gif"
            : "application/octet-stream";

  return { absolutePath, contentType };
}
