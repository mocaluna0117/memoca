// A saved CPU profile (profile-note.mjs --save=dir), looked into: time
// within each React component's render (and what it calls), by its name;
// and, for the functions asked about, who calls them.
//
//   node scripts/ux-explore/inclusive.mjs <profile.json> [--callers=elementsFromPoint,getBoundingClientRect] [--depth=8]
import { readFileSync } from "node:fs";

const [file, ...rest] = process.argv.slice(2);
const arg = (name, fallback) => rest.find((each) => each.startsWith(`--${name}=`))?.split("=")[1] ?? fallback;
const callers = arg("callers", "").split(",").filter(Boolean);
const depth = Number(arg("depth", 8));
const { profile } = JSON.parse(readFileSync(file, "utf8"));

const byId = new Map(profile.nodes.map((node) => [node.id, node]));
const parent = new Map();
for (const node of profile.nodes) for (const child of node.children ?? []) parent.set(child, node.id);
const name = (node) => node.callFrame.functionName || "(anonymous)";
const where = (node) => (node.callFrame.url ? `${node.callFrame.url.split("/").pop()}:${node.callFrame.columnNumber}` : "");
const stackOf = (id) => {
  const frames = [];
  for (let at = id; at !== undefined; at = parent.get(at)) frames.push(byId.get(at));
  return frames;
};
/** A React component's render, by its name: a capitalised function under renderWithHooks. */
const isComponent = (node) => /^[A-Z][A-Za-z0-9]*$/.test(name(node)) && node.callFrame.url;

const components = new Map();
const calledBy = new Map();
let total = 0;
for (let index = 0; index < profile.samples.length; index += 1) {
  const ms = (profile.timeDeltas[index] ?? 0) / 1000;
  const node = byId.get(profile.samples[index]);
  if (["(idle)", "(program)"].includes(name(node))) continue;
  total += ms;
  const stack = stackOf(node.id);
  const seen = new Set();
  for (const frame of stack) {
    if (isComponent(frame) && !seen.has(name(frame))) {
      seen.add(name(frame));
      components.set(name(frame), (components.get(name(frame)) ?? 0) + ms);
    }
  }
  if (callers.includes(name(node))) {
    const path = stack.slice(1, depth + 1).map((frame) => `${name(frame)}@${where(frame)}`).join(" < ");
    const key = `${name(node)} < ${path}`;
    calledBy.set(key, (calledBy.get(key) ?? 0) + ms);
  }
}
const show = (map, count) =>
  [...map].sort((a, b) => b[1] - a[1]).slice(0, count).forEach(([key, ms]) => console.log(`${ms.toFixed(1).padStart(8)}ms  ${key}`));
console.log(`busy ${total.toFixed(0)}ms\n-- components, with what they call`);
show(components, 30);
if (callers.length > 0) {
  console.log("-- callers");
  show(calledBy, 12);
}
