export * as SkillScan from "./skill-scan.js"

import { FSUtil } from "@opencode/util/fs-util"
import path from "path"
import { Effect } from "effect"

const MAX_DEPTH = 6
const MAX_DIRECTORIES = 2000

/** Recursive watches on skill directories ignore what the scan never visits: hidden entries and node_modules. */
export const ignore = ["**/.*", "**/.*/**", "**/node_modules/**", "node_modules"]

/**
 * Finds skill files below `root`. A directory containing `SKILL.md` is one skill, so the scan does not descend into it.
 * Other directories group skills and are walked breadth-first, skipping hidden entries and node_modules, following
 * symlinks once per canonical directory, and stopping at fixed depth and directory limits.
 *
 * Also returns the watches needed to observe content outside `watched`: a recursive watch for each followed grouping
 * directory symlink and a file watch for each skill file whose canonical path is still uncovered.
 */
export const scan = Effect.fn("SkillScan.scan")(function* (root: string, watched: readonly string[]) {
  const fs = yield* FSUtil.Service
  const files: string[] = []
  const links: string[] = []
  const visited = new Set<string>()
  const queue = [{ directory: root, depth: 0, link: false }]
  const limits = { depth: false, directories: false }

  for (const [index, item] of queue.entries()) {
    if (index >= MAX_DIRECTORIES) {
      limits.directories = true
      break
    }
    const entries = yield* fs.readDirectoryEntries(item.directory).pipe(Effect.orElseSucceed(() => []))
    const children = yield* Effect.forEach(
      entries.filter((entry) => !entry.name.startsWith(".")).toSorted((a, b) => (a.name < b.name ? -1 : 1)),
      (entry) =>
        (entry.type === "symlink"
          ? fs.stat(path.join(item.directory, entry.name)).pipe(
              Effect.map((info) => (info.type === "Directory" ? "directory" : info.type === "File" ? "file" : "other")),
              Effect.orElseSucceed(() => "other"),
            )
          : Effect.succeed(entry.type)
        ).pipe(
          Effect.map((type) => ({
            name: entry.name,
            type,
            path: path.join(item.directory, entry.name),
            link: entry.type === "symlink",
          })),
        ),
    )
    const skill = children.find((child) => child.type === "file" && child.name === "SKILL.md")
    if (skill) {
      files.push(skill.path)
      continue
    }
    // Skill directories are never descended, so cycles can only pass through grouping directories.
    const real = yield* fs.realPath(item.directory).pipe(Effect.orElseSucceed(() => undefined))
    if (!real || visited.has(real)) continue
    visited.add(real)
    if (item.link) links.push(real)
    if (item.depth === 0)
      files.push(
        ...children.filter((child) => child.type === "file" && child.name.endsWith(".md")).map((child) => child.path),
      )
    const directories = children.filter((child) => child.type === "directory" && child.name !== "node_modules")
    if (item.depth >= MAX_DEPTH) {
      limits.depth ||= directories.length > 0
      continue
    }
    queue.push(...directories.map((child) => ({ directory: child.path, depth: item.depth + 1, link: child.link })))
  }

  const truncated = limits.depth || limits.directories
  if (truncated)
    yield* Effect.logWarning("skill scan truncated", {
      root,
      ...(limits.depth ? { maxDepth: MAX_DEPTH } : {}),
      ...(limits.directories ? { maxDirectories: MAX_DIRECTORIES } : {}),
    })

  // A recursive watch behind a symlink is only safe when the scan saw the whole tree it covers.
  const directories = truncated
    ? []
    : links
        .toSorted((a, b) => a.length - b.length)
        .filter(
          (link, index, sorted) => ![...watched, ...sorted.slice(0, index)].some((item) => FSUtil.contains(item, link)),
        )
  const covered = [...watched, ...directories]
  const resolved = yield* Effect.forEach(files, (file) => fs.realPath(file).pipe(Effect.orElseSucceed(() => file)))
  return {
    files: files.toSorted(),
    watches: [
      ...directories.map((directory) => ({ path: directory, type: "directory" as const })),
      ...[...new Set(resolved)]
        .filter((file) => !covered.some((item) => FSUtil.contains(item, file)))
        .map((file) => ({ path: file, type: "file" as const })),
    ],
  }
})
