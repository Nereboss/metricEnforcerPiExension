import { isAbsolute, relative, resolve, sep } from "node:path";

export type FileWaivers = Map<string, string>;

export function normalizeProjectRelativeFilePath(filePath: string, projectDirectory: string): string | undefined {
  if (filePath.length === 0 || isAbsolute(filePath)) return undefined;

  const resolvedPath = resolve(projectDirectory, filePath);
  const projectRelativePath = relative(projectDirectory, resolvedPath);

  if (
    projectRelativePath.length === 0 ||
    projectRelativePath === ".." ||
    projectRelativePath.startsWith(`..${sep}`) ||
    isAbsolute(projectRelativePath)
  ) {
    return undefined;
  }

  return projectRelativePath.split(sep).join("/");
}

export function revokeChangedWaivers(waivers: FileWaivers, snapshot: ReadonlyMap<string, string>): string[] {
  const revokedFiles: string[] = [];

  for (const [filePath, waivedHash] of waivers) {
    if (snapshot.get(filePath) === waivedHash) continue;

    waivers.delete(filePath);
    revokedFiles.push(filePath);
  }

  return revokedFiles.sort((left, right) => left.localeCompare(right));
}

export function getEligibleTrackedFiles(
  trackedFiles: ReadonlySet<string>,
  snapshot: ReadonlyMap<string, string>,
  waivers: ReadonlyMap<string, string>,
): string[] {
  return [...trackedFiles]
    .filter((filePath) => snapshot.has(filePath) && !waivers.has(filePath))
    .sort((left, right) => left.localeCompare(right));
}
