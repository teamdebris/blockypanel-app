import { readFileSync } from "node:fs";

const root = new URL("../", import.meta.url);
const json = (file) => JSON.parse(readFileSync(new URL(file, root), "utf8"));
const version = json("package.json").version;
for (const file of ["package-lock.json", "windows/package.json", "windows/package-lock.json"]) {
  const value = json(file);
  if (value.version !== version || (value.packages && value.packages[""].version !== version)) {
    throw new Error(`${file} must use release version ${version}`);
  }
}
const ref = process.env.GITHUB_REF || "";
if (ref.startsWith("refs/tags/") && ref !== `refs/tags/v${version}`) {
  throw new Error(`Release tag must be v${version}, received ${ref}`);
}
console.log(`Both distributions use version ${version}`);
