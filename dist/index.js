var __defProp = Object.defineProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// src/runtime.ts
import { randomUUID as randomUUID3 } from "node:crypto";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Text as Text2 } from "@earendil-works/pi-tui";

// src/final-response-queue.ts
var FinalResponseQueue = class {
  constructor(options) {
    this.options = options;
  }
  pending = [];
  enqueue(items) {
    this.pending.push(...items);
    this.pump();
  }
  slotAvailable() {
    this.pump();
  }
  clear() {
    this.pending.length = 0;
  }
  pump() {
    if (this.options.canLaunch && !this.options.canLaunch()) return;
    while (this.options.activeCount() < this.options.maxParallel() && this.pending.length > 0) {
      const epoch = this.options.currentEpoch();
      const activeShadowIds = this.options.activeShadowIds();
      const index = this.pending.findIndex(
        (item2) => item2.epoch !== epoch || !activeShadowIds.has(item2.shadowId)
      );
      if (index < 0) return;
      const [item] = this.pending.splice(index, 1);
      if (!item || item.epoch !== epoch) continue;
      this.options.launch(item);
    }
  }
};

// src/completion-review.ts
var CompletionReview = class {
  constructor(host) {
    this.host = host;
    this.queue = new FinalResponseQueue({
      currentEpoch: () => this.host.currentEpoch(),
      maxParallel: () => this.host.maxParallel(),
      activeCount: () => this.host.activeCount(),
      activeShadowIds: () => this.host.activeShadowIds(),
      canLaunch: () => this.host.canLaunch ? this.host.canLaunch() : true,
      launch: ({ job, run }) => host.launch(job, run)
    });
  }
  requestId = 0;
  state;
  requestByRun = /* @__PURE__ */ new WeakMap();
  queue;
  begin(epoch) {
    this.invalidate();
    return { id: this.requestId, epoch };
  }
  isCurrent(request) {
    return request.id === this.requestId && request.epoch === this.host.currentEpoch();
  }
  schedule(request, jobs) {
    if (!this.isCurrent(request) || this.state?.requestId === request.id || jobs.some((job) => job.epoch !== request.epoch)) {
      return false;
    }
    if (jobs.length === 0) {
      this.retire(request.id);
      return true;
    }
    this.state = {
      requestId: request.id,
      epoch: request.epoch,
      remaining: jobs.length,
      reports: [],
      shadowIds: jobs.map((job) => job.shadowId)
    };
    this.queue.enqueue(
      jobs.map((job) => {
        const run = {
          accept: (report) => this.accept(request.id, report)
        };
        this.requestByRun.set(run, request.id);
        return { epoch: job.epoch, shadowId: job.shadowId, job, run };
      })
    );
    return true;
  }
  slotAvailable() {
    this.queue.slotAvailable();
  }
  complete(run) {
    if (!run) return;
    const requestId = this.requestByRun.get(run);
    this.requestByRun.delete(run);
    if (requestId === void 0 || this.state?.requestId !== requestId) return;
    this.state.remaining -= 1;
    if (this.state.remaining > 0) return;
    const reports = this.state.reports;
    const shadowIds = this.state.shadowIds;
    this.retire(requestId);
    this.host.onReviewCompleted?.(shadowIds);
    if (reports.length > 0) this.host.deliver(reports);
  }
  cancel(request) {
    if (this.isCurrent(request)) this.retire(request.id);
  }
  invalidate() {
    this.requestId += 1;
    this.state = void 0;
    this.queue.clear();
  }
  retire(requestId) {
    if (requestId !== this.requestId) return;
    this.requestId += 1;
    this.state = void 0;
    this.queue.clear();
  }
  accept(requestId, report) {
    if (this.state?.requestId !== requestId || report.epoch !== this.state.epoch) {
      return;
    }
    this.state.reports.push(report);
  }
};

// src/config.ts
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

// src/validation.ts
var THINKING_LEVELS = /* @__PURE__ */ new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}
function inRange(value, min, max) {
  return value >= min && value <= max;
}
function isNonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "";
}
function isStringArray(value) {
  return Array.isArray(value) && value.every((item) => isNonEmptyString(item));
}
function cleanStringArray(value, fallback, name) {
  if (value === void 0) return [...fallback];
  if (!isStringArray(value))
    throw new Error(`${name} must be an array of non-empty strings`);
  return [...new Set(value.map((item) => item.trim()))];
}
function isThinkingLevel(value) {
  return typeof value === "string" && THINKING_LEVELS.has(value);
}

// src/config.ts
var DEFAULT_EXCLUDED_EXTENSIONS = ["pi-experiencev2"];
var DEFAULT_CONFIG = {
  heartbeatProbability: 1 / 3,
  heartbeatTools: [],
  maxParallelShadows: 2,
  defaultShadowTimeoutSeconds: 300,
  headlessDrainTimeoutSeconds: 120,
  resultBatchWindowMs: 400,
  excludedExtensions: DEFAULT_EXCLUDED_EXTENSIONS,
  defaultThinkingLevel: "low"
};
function parseConfig(input) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("config must be a JSON object");
  }
  const value = input;
  const probability = numberInRange(value.heartbeat_probability, 0, 1, DEFAULT_CONFIG.heartbeatProbability, "heartbeat_probability");
  const heartbeatTools = cleanStringArray(value.heartbeat_tools, DEFAULT_CONFIG.heartbeatTools, "heartbeat_tools");
  const parallel = positiveInteger(value.max_parallel_shadows, DEFAULT_CONFIG.maxParallelShadows, "max_parallel_shadows");
  const timeout = positiveNumber(value.default_shadow_timeout_seconds, DEFAULT_CONFIG.defaultShadowTimeoutSeconds, "default_shadow_timeout_seconds");
  const drainTimeout = positiveNumber(value.headless_drain_timeout_seconds, DEFAULT_CONFIG.headlessDrainTimeoutSeconds, "headless_drain_timeout_seconds");
  const windowMs = nonNegativeInteger(value.result_batch_window_ms, DEFAULT_CONFIG.resultBatchWindowMs, "result_batch_window_ms");
  const excludedExtensions = cleanStringArray(value.excluded_extensions, DEFAULT_CONFIG.excludedExtensions, "excluded_extensions");
  const model = optionalNonEmptyString(value.default_shadow_model, "default_shadow_model");
  const randomSeed = optionalSeed(value.random_seed);
  const thinking = value.default_thinking_level ?? DEFAULT_CONFIG.defaultThinkingLevel;
  if (!isThinkingLevel(thinking)) {
    throw new Error("default_thinking_level is invalid");
  }
  return {
    heartbeatProbability: probability,
    heartbeatTools,
    maxParallelShadows: parallel,
    defaultShadowTimeoutSeconds: timeout,
    headlessDrainTimeoutSeconds: drainTimeout,
    resultBatchWindowMs: windowMs,
    excludedExtensions,
    defaultShadowModel: model,
    defaultThinkingLevel: thinking,
    randomSeed
  };
}
function serializeConfig(config) {
  return `${JSON.stringify({
    heartbeat_probability: config.heartbeatProbability,
    ...config.heartbeatTools && config.heartbeatTools.length ? { heartbeat_tools: config.heartbeatTools } : {},
    max_parallel_shadows: config.maxParallelShadows,
    default_shadow_timeout_seconds: config.defaultShadowTimeoutSeconds,
    headless_drain_timeout_seconds: config.headlessDrainTimeoutSeconds,
    result_batch_window_ms: config.resultBatchWindowMs,
    // Always written, including `[]`: omitting it would silently restore the default.
    excluded_extensions: config.excludedExtensions,
    ...config.defaultShadowModel ? { default_shadow_model: config.defaultShadowModel } : {},
    default_thinking_level: config.defaultThinkingLevel,
    ...config.randomSeed !== void 0 ? { random_seed: config.randomSeed } : {}
  }, null, 2)}
`;
}
var ConfigStore = class {
  constructor(agentDir) {
    this.agentDir = agentDir;
    this.configPath = join(agentDir, "shadow-minds", "config.json");
  }
  configPath;
  lastGood = DEFAULT_CONFIG;
  lastError;
  async initialize() {
    await mkdir(dirname(this.configPath), { recursive: true });
    try {
      await readFile(this.configPath, "utf8");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      await writeFile(this.configPath, serializeConfig(DEFAULT_CONFIG), "utf8");
    }
    await this.reload();
  }
  async reload() {
    try {
      const raw = await readFile(this.configPath, "utf8");
      this.lastGood = parseConfig(JSON.parse(raw));
      this.lastError = void 0;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
    }
    return { config: this.lastGood, error: this.lastError };
  }
  get current() {
    return this.lastGood;
  }
  get error() {
    return this.lastError;
  }
};
function numberInRange(value, min, max, fallback, name) {
  if (value === void 0) return fallback;
  if (!isFiniteNumber(value) || !inRange(value, min, max)) throw new Error(`${name} must be between ${min} and ${max}`);
  return value;
}
function positiveNumber(value, fallback, name) {
  if (value === void 0) return fallback;
  if (!isFiniteNumber(value) || value <= 0) throw new Error(`${name} must be positive`);
  return value;
}
function positiveInteger(value, fallback, name) {
  const parsed = positiveNumber(value, fallback, name);
  if (!Number.isInteger(parsed)) throw new Error(`${name} must be an integer`);
  return parsed;
}
function nonNegativeInteger(value, fallback, name) {
  if (value === void 0) return fallback;
  if (!isFiniteNumber(value) || !Number.isInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`);
  return value;
}
function optionalNonEmptyString(value, name) {
  if (value === void 0) return void 0;
  if (!isNonEmptyString(value)) throw new Error(`${name} must be a non-empty string`);
  return value.trim();
}
function optionalSeed(value) {
  if (value === void 0) return void 0;
  if (!isFiniteNumber(value) || !Number.isInteger(value) || value < 0 || value > 4294967295) {
    throw new Error("random_seed must be an integer between 0 and 4294967295");
  }
  return value;
}

// src/entity-store.ts
import { readFile as readFile3, unlink, writeFile as writeFile2 } from "node:fs/promises";
import { basename as basename2, join as join3 } from "node:path";

// node_modules/yaml/browser/dist/index.js
var dist_exports = {};
__export(dist_exports, {
  Alias: () => Alias,
  CST: () => cst_exports,
  Composer: () => Composer,
  Document: () => Document,
  Lexer: () => Lexer,
  LineCounter: () => LineCounter,
  Pair: () => Pair,
  Parser: () => Parser,
  Scalar: () => Scalar,
  Schema: () => Schema,
  YAMLError: () => YAMLError,
  YAMLMap: () => YAMLMap,
  YAMLParseError: () => YAMLParseError,
  YAMLSeq: () => YAMLSeq,
  YAMLWarning: () => YAMLWarning,
  isAlias: () => isAlias,
  isCollection: () => isCollection,
  isDocument: () => isDocument,
  isMap: () => isMap,
  isNode: () => isNode,
  isPair: () => isPair,
  isScalar: () => isScalar,
  isSeq: () => isSeq,
  parse: () => parse,
  parseAllDocuments: () => parseAllDocuments,
  parseDocument: () => parseDocument,
  stringify: () => stringify3,
  visit: () => visit,
  visitAsync: () => visitAsync
});

// node_modules/yaml/browser/dist/nodes/identity.js
var ALIAS = Symbol.for("yaml.alias");
var DOC = Symbol.for("yaml.document");
var MAP = Symbol.for("yaml.map");
var PAIR = Symbol.for("yaml.pair");
var SCALAR = Symbol.for("yaml.scalar");
var SEQ = Symbol.for("yaml.seq");
var NODE_TYPE = Symbol.for("yaml.node.type");
var isAlias = (node) => !!node && typeof node === "object" && node[NODE_TYPE] === ALIAS;
var isDocument = (node) => !!node && typeof node === "object" && node[NODE_TYPE] === DOC;
var isMap = (node) => !!node && typeof node === "object" && node[NODE_TYPE] === MAP;
var isPair = (node) => !!node && typeof node === "object" && node[NODE_TYPE] === PAIR;
var isScalar = (node) => !!node && typeof node === "object" && node[NODE_TYPE] === SCALAR;
var isSeq = (node) => !!node && typeof node === "object" && node[NODE_TYPE] === SEQ;
function isCollection(node) {
  if (node && typeof node === "object")
    switch (node[NODE_TYPE]) {
      case MAP:
      case SEQ:
        return true;
    }
  return false;
}
function isNode(node) {
  if (node && typeof node === "object")
    switch (node[NODE_TYPE]) {
      case ALIAS:
      case MAP:
      case SCALAR:
      case SEQ:
        return true;
    }
  return false;
}
var hasAnchor = (node) => (isScalar(node) || isCollection(node)) && !!node.anchor;

// node_modules/yaml/browser/dist/visit.js
var BREAK = Symbol("break visit");
var SKIP = Symbol("skip children");
var REMOVE = Symbol("remove node");
function visit(node, visitor) {
  const visitor_ = initVisitor(visitor);
  if (isDocument(node)) {
    const cd = visit_(null, node.contents, visitor_, Object.freeze([node]));
    if (cd === REMOVE)
      node.contents = null;
  } else
    visit_(null, node, visitor_, Object.freeze([]));
}
visit.BREAK = BREAK;
visit.SKIP = SKIP;
visit.REMOVE = REMOVE;
function visit_(key, node, visitor, path) {
  const ctrl = callVisitor(key, node, visitor, path);
  if (isNode(ctrl) || isPair(ctrl)) {
    replaceNode(key, path, ctrl);
    return visit_(key, ctrl, visitor, path);
  }
  if (typeof ctrl !== "symbol") {
    if (isCollection(node)) {
      path = Object.freeze(path.concat(node));
      for (let i = 0; i < node.items.length; ++i) {
        const ci = visit_(i, node.items[i], visitor, path);
        if (typeof ci === "number")
          i = ci - 1;
        else if (ci === BREAK)
          return BREAK;
        else if (ci === REMOVE) {
          node.items.splice(i, 1);
          i -= 1;
        }
      }
    } else if (isPair(node)) {
      path = Object.freeze(path.concat(node));
      const ck = visit_("key", node.key, visitor, path);
      if (ck === BREAK)
        return BREAK;
      else if (ck === REMOVE)
        node.key = null;
      const cv = visit_("value", node.value, visitor, path);
      if (cv === BREAK)
        return BREAK;
      else if (cv === REMOVE)
        node.value = null;
    }
  }
  return ctrl;
}
async function visitAsync(node, visitor) {
  const visitor_ = initVisitor(visitor);
  if (isDocument(node)) {
    const cd = await visitAsync_(null, node.contents, visitor_, Object.freeze([node]));
    if (cd === REMOVE)
      node.contents = null;
  } else
    await visitAsync_(null, node, visitor_, Object.freeze([]));
}
visitAsync.BREAK = BREAK;
visitAsync.SKIP = SKIP;
visitAsync.REMOVE = REMOVE;
async function visitAsync_(key, node, visitor, path) {
  const ctrl = await callVisitor(key, node, visitor, path);
  if (isNode(ctrl) || isPair(ctrl)) {
    replaceNode(key, path, ctrl);
    return visitAsync_(key, ctrl, visitor, path);
  }
  if (typeof ctrl !== "symbol") {
    if (isCollection(node)) {
      path = Object.freeze(path.concat(node));
      for (let i = 0; i < node.items.length; ++i) {
        const ci = await visitAsync_(i, node.items[i], visitor, path);
        if (typeof ci === "number")
          i = ci - 1;
        else if (ci === BREAK)
          return BREAK;
        else if (ci === REMOVE) {
          node.items.splice(i, 1);
          i -= 1;
        }
      }
    } else if (isPair(node)) {
      path = Object.freeze(path.concat(node));
      const ck = await visitAsync_("key", node.key, visitor, path);
      if (ck === BREAK)
        return BREAK;
      else if (ck === REMOVE)
        node.key = null;
      const cv = await visitAsync_("value", node.value, visitor, path);
      if (cv === BREAK)
        return BREAK;
      else if (cv === REMOVE)
        node.value = null;
    }
  }
  return ctrl;
}
function initVisitor(visitor) {
  if (typeof visitor === "object" && (visitor.Collection || visitor.Node || visitor.Value)) {
    return Object.assign({
      Alias: visitor.Node,
      Map: visitor.Node,
      Scalar: visitor.Node,
      Seq: visitor.Node
    }, visitor.Value && {
      Map: visitor.Value,
      Scalar: visitor.Value,
      Seq: visitor.Value
    }, visitor.Collection && {
      Map: visitor.Collection,
      Seq: visitor.Collection
    }, visitor);
  }
  return visitor;
}
function callVisitor(key, node, visitor, path) {
  if (typeof visitor === "function")
    return visitor(key, node, path);
  if (isMap(node))
    return visitor.Map?.(key, node, path);
  if (isSeq(node))
    return visitor.Seq?.(key, node, path);
  if (isPair(node))
    return visitor.Pair?.(key, node, path);
  if (isScalar(node))
    return visitor.Scalar?.(key, node, path);
  if (isAlias(node))
    return visitor.Alias?.(key, node, path);
  return void 0;
}
function replaceNode(key, path, node) {
  const parent = path[path.length - 1];
  if (isCollection(parent)) {
    parent.items[key] = node;
  } else if (isPair(parent)) {
    if (key === "key")
      parent.key = node;
    else
      parent.value = node;
  } else if (isDocument(parent)) {
    parent.contents = node;
  } else {
    const pt = isAlias(parent) ? "alias" : "scalar";
    throw new Error(`Cannot replace node with ${pt} parent`);
  }
}

// node_modules/yaml/browser/dist/doc/directives.js
var escapeChars = {
  "!": "%21",
  ",": "%2C",
  "[": "%5B",
  "]": "%5D",
  "{": "%7B",
  "}": "%7D"
};
var escapeTagName = (tn) => tn.replace(/[!,[\]{}]/g, (ch) => escapeChars[ch]);
var Directives = class _Directives {
  constructor(yaml, tags) {
    this.docStart = null;
    this.docEnd = false;
    this.yaml = Object.assign({}, _Directives.defaultYaml, yaml);
    this.tags = Object.assign({}, _Directives.defaultTags, tags);
  }
  clone() {
    const copy = new _Directives(this.yaml, this.tags);
    copy.docStart = this.docStart;
    return copy;
  }
  /**
   * During parsing, get a Directives instance for the current document and
   * update the stream state according to the current version's spec.
   */
  atDocument() {
    const res = new _Directives(this.yaml, this.tags);
    switch (this.yaml.version) {
      case "1.1":
        this.atNextDocument = true;
        break;
      case "1.2":
        this.atNextDocument = false;
        this.yaml = {
          explicit: _Directives.defaultYaml.explicit,
          version: "1.2"
        };
        this.tags = Object.assign({}, _Directives.defaultTags);
        break;
    }
    return res;
  }
  /**
   * @param onError - May be called even if the action was successful
   * @returns `true` on success
   */
  add(line, onError) {
    if (this.atNextDocument) {
      this.yaml = { explicit: _Directives.defaultYaml.explicit, version: "1.1" };
      this.tags = Object.assign({}, _Directives.defaultTags);
      this.atNextDocument = false;
    }
    const parts = line.trim().split(/[ \t]+/);
    const name = parts.shift();
    switch (name) {
      case "%TAG": {
        if (parts.length !== 2) {
          onError(0, "%TAG directive should contain exactly two parts");
          if (parts.length < 2)
            return false;
        }
        const [handle, prefix] = parts;
        this.tags[handle] = prefix;
        return true;
      }
      case "%YAML": {
        this.yaml.explicit = true;
        if (parts.length !== 1) {
          onError(0, "%YAML directive should contain exactly one part");
          return false;
        }
        const [version] = parts;
        if (version === "1.1" || version === "1.2") {
          this.yaml.version = version;
          return true;
        } else {
          const isValid = /^\d+\.\d+$/.test(version);
          onError(6, `Unsupported YAML version ${version}`, isValid);
          return false;
        }
      }
      default:
        onError(0, `Unknown directive ${name}`, true);
        return false;
    }
  }
  /**
   * Resolves a tag, matching handles to those defined in %TAG directives.
   *
   * @returns Resolved tag, which may also be the non-specific tag `'!'` or a
   *   `'!local'` tag, or `null` if unresolvable.
   */
  tagName(source, onError) {
    if (source === "!")
      return "!";
    if (source[0] !== "!") {
      onError(`Not a valid tag: ${source}`);
      return null;
    }
    if (source[1] === "<") {
      const verbatim = source.slice(2, -1);
      if (verbatim === "!" || verbatim === "!!") {
        onError(`Verbatim tags aren't resolved, so ${source} is invalid.`);
        return null;
      }
      if (source[source.length - 1] !== ">")
        onError("Verbatim tags must end with a >");
      return verbatim;
    }
    const [, handle, suffix] = source.match(/^(.*!)([^!]*)$/s);
    if (!suffix)
      onError(`The ${source} tag has no suffix`);
    const prefix = this.tags[handle];
    if (prefix) {
      try {
        return prefix + decodeURIComponent(suffix);
      } catch (error) {
        onError(String(error));
        return null;
      }
    }
    if (handle === "!")
      return source;
    onError(`Could not resolve tag: ${source}`);
    return null;
  }
  /**
   * Given a fully resolved tag, returns its printable string form,
   * taking into account current tag prefixes and defaults.
   */
  tagString(tag) {
    for (const [handle, prefix] of Object.entries(this.tags)) {
      if (tag.startsWith(prefix))
        return handle + escapeTagName(tag.substring(prefix.length));
    }
    return tag[0] === "!" ? tag : `!<${tag}>`;
  }
  toString(doc) {
    const lines = this.yaml.explicit ? [`%YAML ${this.yaml.version || "1.2"}`] : [];
    const tagEntries = Object.entries(this.tags);
    let tagNames;
    if (doc && tagEntries.length > 0 && isNode(doc.contents)) {
      const tags = {};
      visit(doc.contents, (_key, node) => {
        if (isNode(node) && node.tag)
          tags[node.tag] = true;
      });
      tagNames = Object.keys(tags);
    } else
      tagNames = [];
    for (const [handle, prefix] of tagEntries) {
      if (handle === "!!" && prefix === "tag:yaml.org,2002:")
        continue;
      if (!doc || tagNames.some((tn) => tn.startsWith(prefix)))
        lines.push(`%TAG ${handle} ${prefix}`);
    }
    return lines.join("\n");
  }
};
Directives.defaultYaml = { explicit: false, version: "1.2" };
Directives.defaultTags = { "!!": "tag:yaml.org,2002:" };

// node_modules/yaml/browser/dist/doc/anchors.js
function anchorIsValid(anchor) {
  if (/[\x00-\x19\s,[\]{}]/.test(anchor)) {
    const sa = JSON.stringify(anchor);
    const msg = `Anchor must not contain whitespace or control characters: ${sa}`;
    throw new Error(msg);
  }
  return true;
}
function anchorNames(root) {
  const anchors = /* @__PURE__ */ new Set();
  visit(root, {
    Value(_key, node) {
      if (node.anchor)
        anchors.add(node.anchor);
    }
  });
  return anchors;
}
function findNewAnchor(prefix, exclude) {
  for (let i = 1; true; ++i) {
    const name = `${prefix}${i}`;
    if (!exclude.has(name))
      return name;
  }
}
function createNodeAnchors(doc, prefix) {
  const aliasObjects = [];
  const sourceObjects = /* @__PURE__ */ new Map();
  let prevAnchors = null;
  return {
    onAnchor: (source) => {
      aliasObjects.push(source);
      prevAnchors ?? (prevAnchors = anchorNames(doc));
      const anchor = findNewAnchor(prefix, prevAnchors);
      prevAnchors.add(anchor);
      return anchor;
    },
    /**
     * With circular references, the source node is only resolved after all
     * of its child nodes are. This is why anchors are set only after all of
     * the nodes have been created.
     */
    setAnchors: () => {
      for (const source of aliasObjects) {
        const ref = sourceObjects.get(source);
        if (typeof ref === "object" && ref.anchor && (isScalar(ref.node) || isCollection(ref.node))) {
          ref.node.anchor = ref.anchor;
        } else {
          const error = new Error("Failed to resolve repeated object (this should not happen)");
          error.source = source;
          throw error;
        }
      }
    },
    sourceObjects
  };
}

// node_modules/yaml/browser/dist/doc/applyReviver.js
function applyReviver(reviver, obj, key, val) {
  if (val && typeof val === "object") {
    if (Array.isArray(val)) {
      for (let i = 0, len = val.length; i < len; ++i) {
        const v0 = val[i];
        const v1 = applyReviver(reviver, val, String(i), v0);
        if (v1 === void 0)
          delete val[i];
        else if (v1 !== v0)
          val[i] = v1;
      }
    } else if (val instanceof Map) {
      for (const k of Array.from(val.keys())) {
        const v0 = val.get(k);
        const v1 = applyReviver(reviver, val, k, v0);
        if (v1 === void 0)
          val.delete(k);
        else if (v1 !== v0)
          val.set(k, v1);
      }
    } else if (val instanceof Set) {
      for (const v0 of Array.from(val)) {
        const v1 = applyReviver(reviver, val, v0, v0);
        if (v1 === void 0)
          val.delete(v0);
        else if (v1 !== v0) {
          val.delete(v0);
          val.add(v1);
        }
      }
    } else {
      for (const [k, v0] of Object.entries(val)) {
        const v1 = applyReviver(reviver, val, k, v0);
        if (v1 === void 0)
          delete val[k];
        else if (v1 !== v0)
          val[k] = v1;
      }
    }
  }
  return reviver.call(obj, key, val);
}

// node_modules/yaml/browser/dist/nodes/toJS.js
function toJS(value, arg, ctx) {
  if (Array.isArray(value))
    return value.map((v, i) => toJS(v, String(i), ctx));
  if (value && typeof value.toJSON === "function") {
    if (!ctx || !hasAnchor(value))
      return value.toJSON(arg, ctx);
    const data = { aliasCount: 0, count: 1, res: void 0 };
    ctx.anchors.set(value, data);
    ctx.onCreate = (res2) => {
      data.res = res2;
      delete ctx.onCreate;
    };
    const res = value.toJSON(arg, ctx);
    if (ctx.onCreate)
      ctx.onCreate(res);
    return res;
  }
  if (typeof value === "bigint" && !ctx?.keep)
    return Number(value);
  return value;
}

// node_modules/yaml/browser/dist/nodes/Node.js
var NodeBase = class {
  constructor(type) {
    Object.defineProperty(this, NODE_TYPE, { value: type });
  }
  /** Create a copy of this node.  */
  clone() {
    const copy = Object.create(Object.getPrototypeOf(this), Object.getOwnPropertyDescriptors(this));
    if (this.range)
      copy.range = this.range.slice();
    return copy;
  }
  /** A plain JavaScript representation of this node. */
  toJS(doc, { mapAsMap, maxAliasCount, onAnchor, reviver } = {}) {
    if (!isDocument(doc))
      throw new TypeError("A document argument is required");
    const ctx = {
      anchors: /* @__PURE__ */ new Map(),
      doc,
      keep: true,
      mapAsMap: mapAsMap === true,
      mapKeyWarned: false,
      maxAliasCount: typeof maxAliasCount === "number" ? maxAliasCount : 100
    };
    const res = toJS(this, "", ctx);
    if (typeof onAnchor === "function")
      for (const { count, res: res2 } of ctx.anchors.values())
        onAnchor(res2, count);
    return typeof reviver === "function" ? applyReviver(reviver, { "": res }, "", res) : res;
  }
};

// node_modules/yaml/browser/dist/nodes/Alias.js
var Alias = class extends NodeBase {
  constructor(source) {
    super(ALIAS);
    this.source = source;
    Object.defineProperty(this, "tag", {
      set() {
        throw new Error("Alias nodes cannot have tags");
      }
    });
  }
  /**
   * Resolve the value of this alias within `doc`, finding the last
   * instance of the `source` anchor before this node.
   */
  resolve(doc, ctx) {
    if (ctx?.maxAliasCount === 0)
      throw new ReferenceError("Alias resolution is disabled");
    let nodes;
    if (ctx?.aliasResolveCache) {
      nodes = ctx.aliasResolveCache;
    } else {
      nodes = [];
      visit(doc, {
        Node: (_key, node) => {
          if (isAlias(node) || hasAnchor(node))
            nodes.push(node);
        }
      });
      if (ctx)
        ctx.aliasResolveCache = nodes;
    }
    let found = void 0;
    for (const node of nodes) {
      if (node === this)
        break;
      if (node.anchor === this.source)
        found = node;
    }
    return found;
  }
  toJSON(_arg, ctx) {
    if (!ctx)
      return { source: this.source };
    const { anchors, doc, maxAliasCount } = ctx;
    const source = this.resolve(doc, ctx);
    if (!source) {
      const msg = `Unresolved alias (the anchor must be set before the alias): ${this.source}`;
      throw new ReferenceError(msg);
    }
    let data = anchors.get(source);
    if (!data) {
      toJS(source, null, ctx);
      data = anchors.get(source);
    }
    if (data?.res === void 0) {
      const msg = "This should not happen: Alias anchor was not resolved?";
      throw new ReferenceError(msg);
    }
    if (maxAliasCount >= 0) {
      data.count += 1;
      if (data.aliasCount === 0)
        data.aliasCount = getAliasCount(doc, source, anchors);
      if (data.count * data.aliasCount > maxAliasCount) {
        const msg = "Excessive alias count indicates a resource exhaustion attack";
        throw new ReferenceError(msg);
      }
    }
    return data.res;
  }
  toString(ctx, _onComment, _onChompKeep) {
    const src = `*${this.source}`;
    if (ctx) {
      anchorIsValid(this.source);
      if (ctx.options.verifyAliasOrder && !ctx.anchors.has(this.source)) {
        const msg = `Unresolved alias (the anchor must be set before the alias): ${this.source}`;
        throw new Error(msg);
      }
      if (ctx.implicitKey)
        return `${src} `;
    }
    return src;
  }
};
function getAliasCount(doc, node, anchors) {
  if (isAlias(node)) {
    const source = node.resolve(doc);
    const anchor = anchors && source && anchors.get(source);
    return anchor ? anchor.count * anchor.aliasCount : 0;
  } else if (isCollection(node)) {
    let count = 0;
    for (const item of node.items) {
      const c = getAliasCount(doc, item, anchors);
      if (c > count)
        count = c;
    }
    return count;
  } else if (isPair(node)) {
    const kc = getAliasCount(doc, node.key, anchors);
    const vc = getAliasCount(doc, node.value, anchors);
    return Math.max(kc, vc);
  }
  return 1;
}

// node_modules/yaml/browser/dist/nodes/Scalar.js
var isScalarValue = (value) => !value || typeof value !== "function" && typeof value !== "object";
var Scalar = class extends NodeBase {
  constructor(value) {
    super(SCALAR);
    this.value = value;
  }
  toJSON(arg, ctx) {
    return ctx?.keep ? this.value : toJS(this.value, arg, ctx);
  }
  toString() {
    return String(this.value);
  }
};
Scalar.BLOCK_FOLDED = "BLOCK_FOLDED";
Scalar.BLOCK_LITERAL = "BLOCK_LITERAL";
Scalar.PLAIN = "PLAIN";
Scalar.QUOTE_DOUBLE = "QUOTE_DOUBLE";
Scalar.QUOTE_SINGLE = "QUOTE_SINGLE";

// node_modules/yaml/browser/dist/doc/createNode.js
var defaultTagPrefix = "tag:yaml.org,2002:";
function findTagObject(value, tagName, tags) {
  if (tagName) {
    const match = tags.filter((t) => t.tag === tagName);
    const tagObj = match.find((t) => !t.format) ?? match[0];
    if (!tagObj)
      throw new Error(`Tag ${tagName} not found`);
    return tagObj;
  }
  return tags.find((t) => t.identify?.(value) && !t.format);
}
function createNode(value, tagName, ctx) {
  if (isDocument(value))
    value = value.contents;
  if (isNode(value))
    return value;
  if (isPair(value)) {
    const map2 = ctx.schema[MAP].createNode?.(ctx.schema, null, ctx);
    map2.items.push(value);
    return map2;
  }
  if (value instanceof String || value instanceof Number || value instanceof Boolean || typeof BigInt !== "undefined" && value instanceof BigInt) {
    value = value.valueOf();
  }
  const { aliasDuplicateObjects, onAnchor, onTagObj, schema: schema4, sourceObjects } = ctx;
  let ref = void 0;
  if (aliasDuplicateObjects && value && typeof value === "object") {
    ref = sourceObjects.get(value);
    if (ref) {
      ref.anchor ?? (ref.anchor = onAnchor(value));
      return new Alias(ref.anchor);
    } else {
      ref = { anchor: null, node: null };
      sourceObjects.set(value, ref);
    }
  }
  if (tagName?.startsWith("!!"))
    tagName = defaultTagPrefix + tagName.slice(2);
  let tagObj = findTagObject(value, tagName, schema4.tags);
  if (!tagObj) {
    if (value && typeof value.toJSON === "function") {
      value = value.toJSON();
    }
    if (!value || typeof value !== "object") {
      const node2 = new Scalar(value);
      if (ref)
        ref.node = node2;
      return node2;
    }
    tagObj = value instanceof Map ? schema4[MAP] : Symbol.iterator in Object(value) ? schema4[SEQ] : schema4[MAP];
  }
  if (onTagObj) {
    onTagObj(tagObj);
    delete ctx.onTagObj;
  }
  const node = tagObj?.createNode ? tagObj.createNode(ctx.schema, value, ctx) : typeof tagObj?.nodeClass?.from === "function" ? tagObj.nodeClass.from(ctx.schema, value, ctx) : new Scalar(value);
  if (tagName)
    node.tag = tagName;
  else if (!tagObj.default)
    node.tag = tagObj.tag;
  if (ref)
    ref.node = node;
  return node;
}

// node_modules/yaml/browser/dist/nodes/Collection.js
function collectionFromPath(schema4, path, value) {
  let v = value;
  for (let i = path.length - 1; i >= 0; --i) {
    const k = path[i];
    if (typeof k === "number" && Number.isInteger(k) && k >= 0) {
      const a = [];
      a[k] = v;
      v = a;
    } else {
      v = /* @__PURE__ */ new Map([[k, v]]);
    }
  }
  return createNode(v, void 0, {
    aliasDuplicateObjects: false,
    keepUndefined: false,
    onAnchor: () => {
      throw new Error("This should not happen, please report a bug.");
    },
    schema: schema4,
    sourceObjects: /* @__PURE__ */ new Map()
  });
}
var isEmptyPath = (path) => path == null || typeof path === "object" && !!path[Symbol.iterator]().next().done;
var Collection = class extends NodeBase {
  constructor(type, schema4) {
    super(type);
    Object.defineProperty(this, "schema", {
      value: schema4,
      configurable: true,
      enumerable: false,
      writable: true
    });
  }
  /**
   * Create a copy of this collection.
   *
   * @param schema - If defined, overwrites the original's schema
   */
  clone(schema4) {
    const copy = Object.create(Object.getPrototypeOf(this), Object.getOwnPropertyDescriptors(this));
    if (schema4)
      copy.schema = schema4;
    copy.items = copy.items.map((it) => isNode(it) || isPair(it) ? it.clone(schema4) : it);
    if (this.range)
      copy.range = this.range.slice();
    return copy;
  }
  /**
   * Adds a value to the collection. For `!!map` and `!!omap` the value must
   * be a Pair instance or a `{ key, value }` object, which may not have a key
   * that already exists in the map.
   */
  addIn(path, value) {
    if (isEmptyPath(path))
      this.add(value);
    else {
      const [key, ...rest] = path;
      const node = this.get(key, true);
      if (isCollection(node))
        node.addIn(rest, value);
      else if (node === void 0 && this.schema)
        this.set(key, collectionFromPath(this.schema, rest, value));
      else
        throw new Error(`Expected YAML collection at ${key}. Remaining path: ${rest}`);
    }
  }
  /**
   * Removes a value from the collection.
   * @returns `true` if the item was found and removed.
   */
  deleteIn(path) {
    const [key, ...rest] = path;
    if (rest.length === 0)
      return this.delete(key);
    const node = this.get(key, true);
    if (isCollection(node))
      return node.deleteIn(rest);
    else
      throw new Error(`Expected YAML collection at ${key}. Remaining path: ${rest}`);
  }
  /**
   * Returns item at `key`, or `undefined` if not found. By default unwraps
   * scalar values from their surrounding node; to disable set `keepScalar` to
   * `true` (collections are always returned intact).
   */
  getIn(path, keepScalar) {
    const [key, ...rest] = path;
    const node = this.get(key, true);
    if (rest.length === 0)
      return !keepScalar && isScalar(node) ? node.value : node;
    else
      return isCollection(node) ? node.getIn(rest, keepScalar) : void 0;
  }
  hasAllNullValues(allowScalar) {
    return this.items.every((node) => {
      if (!isPair(node))
        return false;
      const n = node.value;
      return n == null || allowScalar && isScalar(n) && n.value == null && !n.commentBefore && !n.comment && !n.tag;
    });
  }
  /**
   * Checks if the collection includes a value with the key `key`.
   */
  hasIn(path) {
    const [key, ...rest] = path;
    if (rest.length === 0)
      return this.has(key);
    const node = this.get(key, true);
    return isCollection(node) ? node.hasIn(rest) : false;
  }
  /**
   * Sets a value in this collection. For `!!set`, `value` needs to be a
   * boolean to add/remove the item from the set.
   */
  setIn(path, value) {
    const [key, ...rest] = path;
    if (rest.length === 0) {
      this.set(key, value);
    } else {
      const node = this.get(key, true);
      if (isCollection(node))
        node.setIn(rest, value);
      else if (node === void 0 && this.schema)
        this.set(key, collectionFromPath(this.schema, rest, value));
      else
        throw new Error(`Expected YAML collection at ${key}. Remaining path: ${rest}`);
    }
  }
};

// node_modules/yaml/browser/dist/stringify/stringifyComment.js
var stringifyComment = (str) => str.replace(/^(?!$)(?: $)?/gm, "#");
function indentComment(comment, indent) {
  if (/^\n+$/.test(comment))
    return comment.substring(1);
  return indent ? comment.replace(/^(?! *$)/gm, indent) : comment;
}
var lineComment = (str, indent, comment) => str.endsWith("\n") ? indentComment(comment, indent) : comment.includes("\n") ? "\n" + indentComment(comment, indent) : (str.endsWith(" ") ? "" : " ") + comment;

// node_modules/yaml/browser/dist/stringify/foldFlowLines.js
var FOLD_FLOW = "flow";
var FOLD_BLOCK = "block";
var FOLD_QUOTED = "quoted";
function foldFlowLines(text, indent, mode = "flow", { indentAtStart, lineWidth = 80, minContentWidth = 20, onFold, onOverflow } = {}) {
  if (!lineWidth || lineWidth < 0)
    return text;
  if (lineWidth < minContentWidth)
    minContentWidth = 0;
  const endStep = Math.max(1 + minContentWidth, 1 + lineWidth - indent.length);
  if (text.length <= endStep)
    return text;
  const folds = [];
  const escapedFolds = {};
  let end = lineWidth - indent.length;
  if (typeof indentAtStart === "number") {
    if (indentAtStart > lineWidth - Math.max(2, minContentWidth))
      folds.push(0);
    else
      end = lineWidth - indentAtStart;
  }
  let split = void 0;
  let prev = void 0;
  let overflow = false;
  let i = -1;
  let escStart = -1;
  let escEnd = -1;
  if (mode === FOLD_BLOCK) {
    i = consumeMoreIndentedLines(text, i, indent.length);
    if (i !== -1)
      end = i + endStep;
  }
  for (let ch; ch = text[i += 1]; ) {
    if (mode === FOLD_QUOTED && ch === "\\") {
      escStart = i;
      switch (text[i + 1]) {
        case "x":
          i += 3;
          break;
        case "u":
          i += 5;
          break;
        case "U":
          i += 9;
          break;
        default:
          i += 1;
      }
      escEnd = i;
    }
    if (ch === "\n") {
      if (mode === FOLD_BLOCK)
        i = consumeMoreIndentedLines(text, i, indent.length);
      end = i + indent.length + endStep;
      split = void 0;
    } else {
      if (ch === " " && prev && prev !== " " && prev !== "\n" && prev !== "	") {
        const next = text[i + 1];
        if (next && next !== " " && next !== "\n" && next !== "	")
          split = i;
      }
      if (i >= end) {
        if (split) {
          folds.push(split);
          end = split + endStep;
          split = void 0;
        } else if (mode === FOLD_QUOTED) {
          while (prev === " " || prev === "	") {
            prev = ch;
            ch = text[i += 1];
            overflow = true;
          }
          const j = i > escEnd + 1 ? i - 2 : escStart - 1;
          if (escapedFolds[j])
            return text;
          folds.push(j);
          escapedFolds[j] = true;
          end = j + endStep;
          split = void 0;
        } else {
          overflow = true;
        }
      }
    }
    prev = ch;
  }
  if (overflow && onOverflow)
    onOverflow();
  if (folds.length === 0)
    return text;
  if (onFold)
    onFold();
  let res = text.slice(0, folds[0]);
  for (let i2 = 0; i2 < folds.length; ++i2) {
    const fold = folds[i2];
    const end2 = folds[i2 + 1] || text.length;
    if (fold === 0)
      res = `
${indent}${text.slice(0, end2)}`;
    else {
      if (mode === FOLD_QUOTED && escapedFolds[fold])
        res += `${text[fold]}\\`;
      res += `
${indent}${text.slice(fold + 1, end2)}`;
    }
  }
  return res;
}
function consumeMoreIndentedLines(text, i, indent) {
  let end = i;
  let start = i + 1;
  let ch = text[start];
  while (ch === " " || ch === "	") {
    if (i < start + indent) {
      ch = text[++i];
    } else {
      do {
        ch = text[++i];
      } while (ch && ch !== "\n");
      end = i;
      start = i + 1;
      ch = text[start];
    }
  }
  return end;
}

// node_modules/yaml/browser/dist/stringify/stringifyString.js
var getFoldOptions = (ctx, isBlock2) => ({
  indentAtStart: isBlock2 ? ctx.indent.length : ctx.indentAtStart,
  lineWidth: ctx.options.lineWidth,
  minContentWidth: ctx.options.minContentWidth
});
var containsDocumentMarker = (str) => /^(%|---|\.\.\.)/m.test(str);
function lineLengthOverLimit(str, lineWidth, indentLength) {
  if (!lineWidth || lineWidth < 0)
    return false;
  const limit = lineWidth - indentLength;
  const strLen = str.length;
  if (strLen <= limit)
    return false;
  for (let i = 0, start = 0; i < strLen; ++i) {
    if (str[i] === "\n") {
      if (i - start > limit)
        return true;
      start = i + 1;
      if (strLen - start <= limit)
        return false;
    }
  }
  return true;
}
function doubleQuotedString(value, ctx) {
  const json = JSON.stringify(value);
  if (ctx.options.doubleQuotedAsJSON)
    return json;
  const { implicitKey } = ctx;
  const minMultiLineLength = ctx.options.doubleQuotedMinMultiLineLength;
  const indent = ctx.indent || (containsDocumentMarker(value) ? "  " : "");
  let str = "";
  let start = 0;
  for (let i = 0, ch = json[i]; ch; ch = json[++i]) {
    if (ch === " " && json[i + 1] === "\\" && json[i + 2] === "n") {
      str += json.slice(start, i) + "\\ ";
      i += 1;
      start = i;
      ch = "\\";
    }
    if (ch === "\\")
      switch (json[i + 1]) {
        case "u":
          {
            str += json.slice(start, i);
            const code = json.substr(i + 2, 4);
            switch (code) {
              case "0000":
                str += "\\0";
                break;
              case "0007":
                str += "\\a";
                break;
              case "000b":
                str += "\\v";
                break;
              case "001b":
                str += "\\e";
                break;
              case "0085":
                str += "\\N";
                break;
              case "00a0":
                str += "\\_";
                break;
              case "2028":
                str += "\\L";
                break;
              case "2029":
                str += "\\P";
                break;
              default:
                if (code.substr(0, 2) === "00")
                  str += "\\x" + code.substr(2);
                else
                  str += json.substr(i, 6);
            }
            i += 5;
            start = i + 1;
          }
          break;
        case "n":
          if (implicitKey || json[i + 2] === '"' || json.length < minMultiLineLength) {
            i += 1;
          } else {
            str += json.slice(start, i) + "\n\n";
            while (json[i + 2] === "\\" && json[i + 3] === "n" && json[i + 4] !== '"') {
              str += "\n";
              i += 2;
            }
            str += indent;
            if (json[i + 2] === " ")
              str += "\\";
            i += 1;
            start = i + 1;
          }
          break;
        default:
          i += 1;
      }
  }
  str = start ? str + json.slice(start) : json;
  return implicitKey ? str : foldFlowLines(str, indent, FOLD_QUOTED, getFoldOptions(ctx, false));
}
function singleQuotedString(value, ctx) {
  if (ctx.options.singleQuote === false || ctx.implicitKey && value.includes("\n") || /[ \t]\n|\n[ \t]/.test(value))
    return doubleQuotedString(value, ctx);
  const indent = ctx.indent || (containsDocumentMarker(value) ? "  " : "");
  const res = "'" + value.replace(/'/g, "''").replace(/\n+/g, `$&
${indent}`) + "'";
  return ctx.implicitKey ? res : foldFlowLines(res, indent, FOLD_FLOW, getFoldOptions(ctx, false));
}
function quotedString(value, ctx) {
  const { singleQuote } = ctx.options;
  let qs;
  if (singleQuote === false)
    qs = doubleQuotedString;
  else {
    const hasDouble = value.includes('"');
    const hasSingle = value.includes("'");
    if (hasDouble && !hasSingle)
      qs = singleQuotedString;
    else if (hasSingle && !hasDouble)
      qs = doubleQuotedString;
    else
      qs = singleQuote ? singleQuotedString : doubleQuotedString;
  }
  return qs(value, ctx);
}
var blockEndNewlines;
try {
  blockEndNewlines = new RegExp("(^|(?<!\n))\n+(?!\n|$)", "g");
} catch {
  blockEndNewlines = /\n+(?!\n|$)/g;
}
function blockString({ comment, type, value }, ctx, onComment, onChompKeep) {
  const { blockQuote, commentString, lineWidth } = ctx.options;
  if (!blockQuote || /\n[\t ]+$/.test(value)) {
    return quotedString(value, ctx);
  }
  const indent = ctx.indent || (ctx.forceBlockIndent || containsDocumentMarker(value) ? "  " : "");
  const literal = blockQuote === "literal" ? true : blockQuote === "folded" || type === Scalar.BLOCK_FOLDED ? false : type === Scalar.BLOCK_LITERAL ? true : !lineLengthOverLimit(value, lineWidth, indent.length);
  if (!value)
    return literal ? "|\n" : ">\n";
  let chomp;
  let endStart;
  for (endStart = value.length; endStart > 0; --endStart) {
    const ch = value[endStart - 1];
    if (ch !== "\n" && ch !== "	" && ch !== " ")
      break;
  }
  let end = value.substring(endStart);
  const endNlPos = end.indexOf("\n");
  if (endNlPos === -1) {
    chomp = "-";
  } else if (value === end || endNlPos !== end.length - 1) {
    chomp = "+";
    if (onChompKeep)
      onChompKeep();
  } else {
    chomp = "";
  }
  if (end) {
    value = value.slice(0, -end.length);
    if (end[end.length - 1] === "\n")
      end = end.slice(0, -1);
    end = end.replace(blockEndNewlines, `$&${indent}`);
  }
  let startWithSpace = false;
  let startEnd;
  let startNlPos = -1;
  for (startEnd = 0; startEnd < value.length; ++startEnd) {
    const ch = value[startEnd];
    if (ch === " ")
      startWithSpace = true;
    else if (ch === "\n")
      startNlPos = startEnd;
    else
      break;
  }
  let start = value.substring(0, startNlPos < startEnd ? startNlPos + 1 : startEnd);
  if (start) {
    value = value.substring(start.length);
    start = start.replace(/\n+/g, `$&${indent}`);
  }
  const indentSize = indent ? "2" : "1";
  let header = (startWithSpace ? indentSize : "") + chomp;
  if (comment) {
    header += " " + commentString(comment.replace(/ ?[\r\n]+/g, " "));
    if (onComment)
      onComment();
  }
  if (!literal) {
    const foldedValue = value.replace(/\n+/g, "\n$&").replace(/(?:^|\n)([\t ].*)(?:([\n\t ]*)\n(?![\n\t ]))?/g, "$1$2").replace(/\n+/g, `$&${indent}`);
    let literalFallback = false;
    const foldOptions = getFoldOptions(ctx, true);
    if (blockQuote !== "folded" && type !== Scalar.BLOCK_FOLDED) {
      foldOptions.onOverflow = () => {
        literalFallback = true;
      };
    }
    const body = foldFlowLines(`${start}${foldedValue}${end}`, indent, FOLD_BLOCK, foldOptions);
    if (!literalFallback)
      return `>${header}
${indent}${body}`;
  }
  value = value.replace(/\n+/g, `$&${indent}`);
  return `|${header}
${indent}${start}${value}${end}`;
}
function plainString(item, ctx, onComment, onChompKeep) {
  const { type, value } = item;
  const { actualString, implicitKey, indent, indentStep, inFlow } = ctx;
  if (implicitKey && value.includes("\n") || inFlow && /[[\]{},]/.test(value)) {
    return quotedString(value, ctx);
  }
  if (/^[\n\t ,[\]{}#&*!|>'"%@`]|^[?-]$|^[?-][ \t]|[\n:][ \t]|[ \t]\n|[\n\t ]#|[\n\t :]$/.test(value)) {
    return implicitKey || inFlow || !value.includes("\n") ? quotedString(value, ctx) : blockString(item, ctx, onComment, onChompKeep);
  }
  if (!implicitKey && !inFlow && type !== Scalar.PLAIN && value.includes("\n")) {
    return blockString(item, ctx, onComment, onChompKeep);
  }
  if (containsDocumentMarker(value)) {
    if (indent === "") {
      ctx.forceBlockIndent = true;
      return blockString(item, ctx, onComment, onChompKeep);
    } else if (implicitKey && indent === indentStep) {
      return quotedString(value, ctx);
    }
  }
  const str = value.replace(/\n+/g, `$&
${indent}`);
  if (actualString) {
    const test = (tag) => tag.default && tag.tag !== "tag:yaml.org,2002:str" && tag.test?.test(str);
    const { compat, tags } = ctx.doc.schema;
    if (tags.some(test) || compat?.some(test))
      return quotedString(value, ctx);
  }
  return implicitKey ? str : foldFlowLines(str, indent, FOLD_FLOW, getFoldOptions(ctx, false));
}
function stringifyString(item, ctx, onComment, onChompKeep) {
  const { implicitKey, inFlow } = ctx;
  const ss = typeof item.value === "string" ? item : Object.assign({}, item, { value: String(item.value) });
  let { type } = item;
  if (type !== Scalar.QUOTE_DOUBLE) {
    if (/[\x00-\x08\x0b-\x1f\x7f-\x9f\u{D800}-\u{DFFF}]/u.test(ss.value))
      type = Scalar.QUOTE_DOUBLE;
  }
  const _stringify = (_type) => {
    switch (_type) {
      case Scalar.BLOCK_FOLDED:
      case Scalar.BLOCK_LITERAL:
        return implicitKey || inFlow ? quotedString(ss.value, ctx) : blockString(ss, ctx, onComment, onChompKeep);
      case Scalar.QUOTE_DOUBLE:
        return doubleQuotedString(ss.value, ctx);
      case Scalar.QUOTE_SINGLE:
        return singleQuotedString(ss.value, ctx);
      case Scalar.PLAIN:
        return plainString(ss, ctx, onComment, onChompKeep);
      default:
        return null;
    }
  };
  let res = _stringify(type);
  if (res === null) {
    const { defaultKeyType, defaultStringType } = ctx.options;
    const t = implicitKey && defaultKeyType || defaultStringType;
    res = _stringify(t);
    if (res === null)
      throw new Error(`Unsupported default string type ${t}`);
  }
  return res;
}

// node_modules/yaml/browser/dist/stringify/stringify.js
function createStringifyContext(doc, options) {
  const opt = Object.assign({
    blockQuote: true,
    commentString: stringifyComment,
    defaultKeyType: null,
    defaultStringType: "PLAIN",
    directives: null,
    doubleQuotedAsJSON: false,
    doubleQuotedMinMultiLineLength: 40,
    falseStr: "false",
    flowCollectionPadding: true,
    indentSeq: true,
    lineWidth: 80,
    minContentWidth: 20,
    nullStr: "null",
    simpleKeys: false,
    singleQuote: null,
    trailingComma: false,
    trueStr: "true",
    verifyAliasOrder: true
  }, doc.schema.toStringOptions, options);
  let inFlow;
  switch (opt.collectionStyle) {
    case "block":
      inFlow = false;
      break;
    case "flow":
      inFlow = true;
      break;
    default:
      inFlow = null;
  }
  return {
    anchors: /* @__PURE__ */ new Set(),
    doc,
    flowCollectionPadding: opt.flowCollectionPadding ? " " : "",
    indent: "",
    indentStep: typeof opt.indent === "number" ? " ".repeat(opt.indent) : "  ",
    inFlow,
    options: opt
  };
}
function getTagObject(tags, item) {
  if (item.tag) {
    const match = tags.filter((t) => t.tag === item.tag);
    if (match.length > 0)
      return match.find((t) => t.format === item.format) ?? match[0];
  }
  let tagObj = void 0;
  let obj;
  if (isScalar(item)) {
    obj = item.value;
    let match = tags.filter((t) => t.identify?.(obj));
    if (match.length > 1) {
      const testMatch = match.filter((t) => t.test);
      if (testMatch.length > 0)
        match = testMatch;
    }
    tagObj = match.find((t) => t.format === item.format) ?? match.find((t) => !t.format);
  } else {
    obj = item;
    tagObj = tags.find((t) => t.nodeClass && obj instanceof t.nodeClass);
  }
  if (!tagObj) {
    const name = obj?.constructor?.name ?? (obj === null ? "null" : typeof obj);
    throw new Error(`Tag not resolved for ${name} value`);
  }
  return tagObj;
}
function stringifyProps(node, tagObj, { anchors, doc }) {
  if (!doc.directives)
    return "";
  const props = [];
  const anchor = (isScalar(node) || isCollection(node)) && node.anchor;
  if (anchor && anchorIsValid(anchor)) {
    anchors.add(anchor);
    props.push(`&${anchor}`);
  }
  const tag = node.tag ?? (tagObj.default ? null : tagObj.tag);
  if (tag)
    props.push(doc.directives.tagString(tag));
  return props.join(" ");
}
function stringify(item, ctx, onComment, onChompKeep) {
  if (isPair(item))
    return item.toString(ctx, onComment, onChompKeep);
  if (isAlias(item)) {
    if (ctx.doc.directives)
      return item.toString(ctx);
    if (ctx.resolvedAliases?.has(item)) {
      throw new TypeError(`Cannot stringify circular structure without alias nodes`);
    } else {
      if (ctx.resolvedAliases)
        ctx.resolvedAliases.add(item);
      else
        ctx.resolvedAliases = /* @__PURE__ */ new Set([item]);
      item = item.resolve(ctx.doc);
    }
  }
  let tagObj = void 0;
  const node = isNode(item) ? item : ctx.doc.createNode(item, { onTagObj: (o) => tagObj = o });
  tagObj ?? (tagObj = getTagObject(ctx.doc.schema.tags, node));
  const props = stringifyProps(node, tagObj, ctx);
  if (props.length > 0)
    ctx.indentAtStart = (ctx.indentAtStart ?? 0) + props.length + 1;
  const str = typeof tagObj.stringify === "function" ? tagObj.stringify(node, ctx, onComment, onChompKeep) : isScalar(node) ? stringifyString(node, ctx, onComment, onChompKeep) : node.toString(ctx, onComment, onChompKeep);
  if (!props)
    return str;
  return isScalar(node) || str[0] === "{" || str[0] === "[" ? `${props} ${str}` : `${props}
${ctx.indent}${str}`;
}

// node_modules/yaml/browser/dist/stringify/stringifyPair.js
function stringifyPair({ key, value }, ctx, onComment, onChompKeep) {
  const { allNullValues, doc, indent, indentStep, options: { commentString, indentSeq, simpleKeys } } = ctx;
  let keyComment = isNode(key) && key.comment || null;
  if (simpleKeys) {
    if (keyComment) {
      throw new Error("With simple keys, key nodes cannot have comments");
    }
    if (isCollection(key) || !isNode(key) && typeof key === "object") {
      const msg = "With simple keys, collection cannot be used as a key value";
      throw new Error(msg);
    }
  }
  let explicitKey = !simpleKeys && (!key || keyComment && value == null && !ctx.inFlow || isCollection(key) || (isScalar(key) ? key.type === Scalar.BLOCK_FOLDED || key.type === Scalar.BLOCK_LITERAL : typeof key === "object"));
  ctx = Object.assign({}, ctx, {
    allNullValues: false,
    implicitKey: !explicitKey && (simpleKeys || !allNullValues),
    indent: indent + indentStep
  });
  let keyCommentDone = false;
  let chompKeep = false;
  let str = stringify(key, ctx, () => keyCommentDone = true, () => chompKeep = true);
  if (!explicitKey && !ctx.inFlow && str.length > 1024) {
    if (simpleKeys)
      throw new Error("With simple keys, single line scalar must not span more than 1024 characters");
    explicitKey = true;
  }
  if (ctx.inFlow) {
    if (allNullValues || value == null) {
      if (keyCommentDone && onComment)
        onComment();
      return str === "" ? "?" : explicitKey ? `? ${str}` : str;
    }
  } else if (allNullValues && !simpleKeys || value == null && explicitKey) {
    str = `? ${str}`;
    if (keyComment && !keyCommentDone) {
      str += lineComment(str, ctx.indent, commentString(keyComment));
    } else if (chompKeep && onChompKeep)
      onChompKeep();
    return str;
  }
  if (keyCommentDone)
    keyComment = null;
  if (explicitKey) {
    if (keyComment)
      str += lineComment(str, ctx.indent, commentString(keyComment));
    str = `? ${str}
${indent}:`;
  } else {
    str = `${str}:`;
    if (keyComment)
      str += lineComment(str, ctx.indent, commentString(keyComment));
  }
  let vsb, vcb, valueComment;
  if (isNode(value)) {
    vsb = !!value.spaceBefore;
    vcb = value.commentBefore;
    valueComment = value.comment;
  } else {
    vsb = false;
    vcb = null;
    valueComment = null;
    if (value && typeof value === "object")
      value = doc.createNode(value);
  }
  ctx.implicitKey = false;
  if (!explicitKey && !keyComment && isScalar(value))
    ctx.indentAtStart = str.length + 1;
  chompKeep = false;
  if (!indentSeq && indentStep.length >= 2 && !ctx.inFlow && !explicitKey && isSeq(value) && !value.flow && !value.tag && !value.anchor) {
    ctx.indent = ctx.indent.substring(2);
  }
  let valueCommentDone = false;
  const valueStr = stringify(value, ctx, () => valueCommentDone = true, () => chompKeep = true);
  let ws = " ";
  if (keyComment || vsb || vcb) {
    ws = vsb ? "\n" : "";
    if (vcb) {
      const cs = commentString(vcb);
      ws += `
${indentComment(cs, ctx.indent)}`;
    }
    if (valueStr === "" && !ctx.inFlow) {
      if (ws === "\n" && valueComment)
        ws = "\n\n";
    } else {
      ws += `
${ctx.indent}`;
    }
  } else if (!explicitKey && isCollection(value)) {
    const vs0 = valueStr[0];
    const nl0 = valueStr.indexOf("\n");
    const hasNewline = nl0 !== -1;
    const flow = ctx.inFlow ?? value.flow ?? value.items.length === 0;
    if (hasNewline || !flow) {
      let hasPropsLine = false;
      if (hasNewline && (vs0 === "&" || vs0 === "!")) {
        let sp0 = valueStr.indexOf(" ");
        if (vs0 === "&" && sp0 !== -1 && sp0 < nl0 && valueStr[sp0 + 1] === "!") {
          sp0 = valueStr.indexOf(" ", sp0 + 1);
        }
        if (sp0 === -1 || nl0 < sp0)
          hasPropsLine = true;
      }
      if (!hasPropsLine)
        ws = `
${ctx.indent}`;
    }
  } else if (valueStr === "" || valueStr[0] === "\n") {
    ws = "";
  }
  str += ws + valueStr;
  if (ctx.inFlow) {
    if (valueCommentDone && onComment)
      onComment();
  } else if (valueComment && !valueCommentDone) {
    str += lineComment(str, ctx.indent, commentString(valueComment));
  } else if (chompKeep && onChompKeep) {
    onChompKeep();
  }
  return str;
}

// node_modules/yaml/browser/dist/log.js
function warn(logLevel, warning) {
  if (logLevel === "debug" || logLevel === "warn") {
    console.warn(warning);
  }
}

// node_modules/yaml/browser/dist/schema/yaml-1.1/merge.js
var MERGE_KEY = "<<";
var merge = {
  identify: (value) => value === MERGE_KEY || typeof value === "symbol" && value.description === MERGE_KEY,
  default: "key",
  tag: "tag:yaml.org,2002:merge",
  test: /^<<$/,
  resolve: () => Object.assign(new Scalar(Symbol(MERGE_KEY)), {
    addToJSMap: addMergeToJSMap
  }),
  stringify: () => MERGE_KEY
};
var isMergeKey = (ctx, key) => (merge.identify(key) || isScalar(key) && (!key.type || key.type === Scalar.PLAIN) && merge.identify(key.value)) && ctx?.doc.schema.tags.some((tag) => tag.tag === merge.tag && tag.default);
function addMergeToJSMap(ctx, map2, value) {
  const source = resolveAliasValue(ctx, value);
  if (isSeq(source))
    for (const it of source.items)
      mergeValue(ctx, map2, it);
  else if (Array.isArray(source))
    for (const it of source)
      mergeValue(ctx, map2, it);
  else
    mergeValue(ctx, map2, source);
}
function mergeValue(ctx, map2, value) {
  const source = resolveAliasValue(ctx, value);
  if (!isMap(source))
    throw new Error("Merge sources must be maps or map aliases");
  const srcMap = source.toJSON(null, ctx, Map);
  for (const [key, value2] of srcMap) {
    if (map2 instanceof Map) {
      if (!map2.has(key))
        map2.set(key, value2);
    } else if (map2 instanceof Set) {
      map2.add(key);
    } else if (!Object.prototype.hasOwnProperty.call(map2, key)) {
      Object.defineProperty(map2, key, {
        value: value2,
        writable: true,
        enumerable: true,
        configurable: true
      });
    }
  }
  return map2;
}
function resolveAliasValue(ctx, value) {
  return ctx && isAlias(value) ? value.resolve(ctx.doc, ctx) : value;
}

// node_modules/yaml/browser/dist/nodes/addPairToJSMap.js
function addPairToJSMap(ctx, map2, { key, value }) {
  if (isNode(key) && key.addToJSMap)
    key.addToJSMap(ctx, map2, value);
  else if (isMergeKey(ctx, key))
    addMergeToJSMap(ctx, map2, value);
  else {
    const jsKey = toJS(key, "", ctx);
    if (map2 instanceof Map) {
      map2.set(jsKey, toJS(value, jsKey, ctx));
    } else if (map2 instanceof Set) {
      map2.add(jsKey);
    } else {
      const stringKey = stringifyKey(key, jsKey, ctx);
      const jsValue = toJS(value, stringKey, ctx);
      if (stringKey in map2)
        Object.defineProperty(map2, stringKey, {
          value: jsValue,
          writable: true,
          enumerable: true,
          configurable: true
        });
      else
        map2[stringKey] = jsValue;
    }
  }
  return map2;
}
function stringifyKey(key, jsKey, ctx) {
  if (jsKey === null)
    return "";
  if (typeof jsKey !== "object")
    return String(jsKey);
  if (isNode(key) && ctx?.doc) {
    const strCtx = createStringifyContext(ctx.doc, {});
    strCtx.anchors = /* @__PURE__ */ new Set();
    for (const node of ctx.anchors.keys())
      strCtx.anchors.add(node.anchor);
    strCtx.inFlow = true;
    strCtx.inStringifyKey = true;
    const strKey = key.toString(strCtx);
    if (!ctx.mapKeyWarned) {
      let jsonStr = JSON.stringify(strKey);
      if (jsonStr.length > 40)
        jsonStr = jsonStr.substring(0, 36) + '..."';
      warn(ctx.doc.options.logLevel, `Keys with collection values will be stringified due to JS Object restrictions: ${jsonStr}. Set mapAsMap: true to use object keys.`);
      ctx.mapKeyWarned = true;
    }
    return strKey;
  }
  return JSON.stringify(jsKey);
}

// node_modules/yaml/browser/dist/nodes/Pair.js
function createPair(key, value, ctx) {
  const k = createNode(key, void 0, ctx);
  const v = createNode(value, void 0, ctx);
  return new Pair(k, v);
}
var Pair = class _Pair {
  constructor(key, value = null) {
    Object.defineProperty(this, NODE_TYPE, { value: PAIR });
    this.key = key;
    this.value = value;
  }
  clone(schema4) {
    let { key, value } = this;
    if (isNode(key))
      key = key.clone(schema4);
    if (isNode(value))
      value = value.clone(schema4);
    return new _Pair(key, value);
  }
  toJSON(_, ctx) {
    const pair = ctx?.mapAsMap ? /* @__PURE__ */ new Map() : {};
    return addPairToJSMap(ctx, pair, this);
  }
  toString(ctx, onComment, onChompKeep) {
    return ctx?.doc ? stringifyPair(this, ctx, onComment, onChompKeep) : JSON.stringify(this);
  }
};

// node_modules/yaml/browser/dist/stringify/stringifyCollection.js
function stringifyCollection(collection, ctx, options) {
  const flow = ctx.inFlow ?? collection.flow;
  const stringify4 = flow ? stringifyFlowCollection : stringifyBlockCollection;
  return stringify4(collection, ctx, options);
}
function stringifyBlockCollection({ comment, items }, ctx, { blockItemPrefix, flowChars, itemIndent, onChompKeep, onComment }) {
  const { indent, options: { commentString } } = ctx;
  const itemCtx = Object.assign({}, ctx, { indent: itemIndent, type: null });
  let chompKeep = false;
  const lines = [];
  for (let i = 0; i < items.length; ++i) {
    const item = items[i];
    let comment2 = null;
    if (isNode(item)) {
      if (!chompKeep && item.spaceBefore)
        lines.push("");
      addCommentBefore(ctx, lines, item.commentBefore, chompKeep);
      if (item.comment)
        comment2 = item.comment;
    } else if (isPair(item)) {
      const ik = isNode(item.key) ? item.key : null;
      if (ik) {
        if (!chompKeep && ik.spaceBefore)
          lines.push("");
        addCommentBefore(ctx, lines, ik.commentBefore, chompKeep);
      }
    }
    chompKeep = false;
    let str2 = stringify(item, itemCtx, () => comment2 = null, () => chompKeep = true);
    if (comment2)
      str2 += lineComment(str2, itemIndent, commentString(comment2));
    if (chompKeep && comment2)
      chompKeep = false;
    lines.push(blockItemPrefix + str2);
  }
  let str;
  if (lines.length === 0) {
    str = flowChars.start + flowChars.end;
  } else {
    str = lines[0];
    for (let i = 1; i < lines.length; ++i) {
      const line = lines[i];
      str += line ? `
${indent}${line}` : "\n";
    }
  }
  if (comment) {
    str += "\n" + indentComment(commentString(comment), indent);
    if (onComment)
      onComment();
  } else if (chompKeep && onChompKeep)
    onChompKeep();
  return str;
}
function stringifyFlowCollection({ items }, ctx, { flowChars, itemIndent }) {
  const { indent, indentStep, flowCollectionPadding: fcPadding, options: { commentString } } = ctx;
  itemIndent += indentStep;
  const itemCtx = Object.assign({}, ctx, {
    indent: itemIndent,
    inFlow: true,
    type: null
  });
  let reqNewline = false;
  let linesAtValue = 0;
  const lines = [];
  for (let i = 0; i < items.length; ++i) {
    const item = items[i];
    let comment = null;
    if (isNode(item)) {
      if (item.spaceBefore)
        lines.push("");
      addCommentBefore(ctx, lines, item.commentBefore, false);
      if (item.comment)
        comment = item.comment;
    } else if (isPair(item)) {
      const ik = isNode(item.key) ? item.key : null;
      if (ik) {
        if (ik.spaceBefore)
          lines.push("");
        addCommentBefore(ctx, lines, ik.commentBefore, false);
        if (ik.comment)
          reqNewline = true;
      }
      const iv = isNode(item.value) ? item.value : null;
      if (iv) {
        if (iv.comment)
          comment = iv.comment;
        if (iv.commentBefore)
          reqNewline = true;
      } else if (item.value == null && ik?.comment) {
        comment = ik.comment;
      }
    }
    if (comment)
      reqNewline = true;
    let str = stringify(item, itemCtx, () => comment = null);
    reqNewline || (reqNewline = lines.length > linesAtValue || str.includes("\n"));
    if (i < items.length - 1) {
      str += ",";
    } else if (ctx.options.trailingComma) {
      if (ctx.options.lineWidth > 0) {
        reqNewline || (reqNewline = lines.reduce((sum, line) => sum + line.length + 2, 2) + (str.length + 2) > ctx.options.lineWidth);
      }
      if (reqNewline) {
        str += ",";
      }
    }
    if (comment)
      str += lineComment(str, itemIndent, commentString(comment));
    lines.push(str);
    linesAtValue = lines.length;
  }
  const { start, end } = flowChars;
  if (lines.length === 0) {
    return start + end;
  } else {
    if (!reqNewline) {
      const len = lines.reduce((sum, line) => sum + line.length + 2, 2);
      reqNewline = ctx.options.lineWidth > 0 && len > ctx.options.lineWidth;
    }
    if (reqNewline) {
      let str = start;
      for (const line of lines)
        str += line ? `
${indentStep}${indent}${line}` : "\n";
      return `${str}
${indent}${end}`;
    } else {
      return `${start}${fcPadding}${lines.join(" ")}${fcPadding}${end}`;
    }
  }
}
function addCommentBefore({ indent, options: { commentString } }, lines, comment, chompKeep) {
  if (comment && chompKeep)
    comment = comment.replace(/^\n+/, "");
  if (comment) {
    const ic = indentComment(commentString(comment), indent);
    lines.push(ic.trimStart());
  }
}

// node_modules/yaml/browser/dist/nodes/YAMLMap.js
function findPair(items, key) {
  const k = isScalar(key) ? key.value : key;
  for (const it of items) {
    if (isPair(it)) {
      if (it.key === key || it.key === k)
        return it;
      if (isScalar(it.key) && it.key.value === k)
        return it;
    }
  }
  return void 0;
}
var YAMLMap = class extends Collection {
  static get tagName() {
    return "tag:yaml.org,2002:map";
  }
  constructor(schema4) {
    super(MAP, schema4);
    this.items = [];
  }
  /**
   * A generic collection parsing method that can be extended
   * to other node classes that inherit from YAMLMap
   */
  static from(schema4, obj, ctx) {
    const { keepUndefined, replacer } = ctx;
    const map2 = new this(schema4);
    const add = (key, value) => {
      if (typeof replacer === "function")
        value = replacer.call(obj, key, value);
      else if (Array.isArray(replacer) && !replacer.includes(key))
        return;
      if (value !== void 0 || keepUndefined)
        map2.items.push(createPair(key, value, ctx));
    };
    if (obj instanceof Map) {
      for (const [key, value] of obj)
        add(key, value);
    } else if (obj && typeof obj === "object") {
      for (const key of Object.keys(obj))
        add(key, obj[key]);
    }
    if (typeof schema4.sortMapEntries === "function") {
      map2.items.sort(schema4.sortMapEntries);
    }
    return map2;
  }
  /**
   * Adds a value to the collection.
   *
   * @param overwrite - If not set `true`, using a key that is already in the
   *   collection will throw. Otherwise, overwrites the previous value.
   */
  add(pair, overwrite) {
    let _pair;
    if (isPair(pair))
      _pair = pair;
    else if (!pair || typeof pair !== "object" || !("key" in pair)) {
      _pair = new Pair(pair, pair?.value);
    } else
      _pair = new Pair(pair.key, pair.value);
    const prev = findPair(this.items, _pair.key);
    const sortEntries = this.schema?.sortMapEntries;
    if (prev) {
      if (!overwrite)
        throw new Error(`Key ${_pair.key} already set`);
      if (isScalar(prev.value) && isScalarValue(_pair.value))
        prev.value.value = _pair.value;
      else
        prev.value = _pair.value;
    } else if (sortEntries) {
      const i = this.items.findIndex((item) => sortEntries(_pair, item) < 0);
      if (i === -1)
        this.items.push(_pair);
      else
        this.items.splice(i, 0, _pair);
    } else {
      this.items.push(_pair);
    }
  }
  delete(key) {
    const it = findPair(this.items, key);
    if (!it)
      return false;
    const del = this.items.splice(this.items.indexOf(it), 1);
    return del.length > 0;
  }
  get(key, keepScalar) {
    const it = findPair(this.items, key);
    const node = it?.value;
    return (!keepScalar && isScalar(node) ? node.value : node) ?? void 0;
  }
  has(key) {
    return !!findPair(this.items, key);
  }
  set(key, value) {
    this.add(new Pair(key, value), true);
  }
  /**
   * @param ctx - Conversion context, originally set in Document#toJS()
   * @param {Class} Type - If set, forces the returned collection type
   * @returns Instance of Type, Map, or Object
   */
  toJSON(_, ctx, Type3) {
    const map2 = Type3 ? new Type3() : ctx?.mapAsMap ? /* @__PURE__ */ new Map() : {};
    if (ctx?.onCreate)
      ctx.onCreate(map2);
    for (const item of this.items)
      addPairToJSMap(ctx, map2, item);
    return map2;
  }
  toString(ctx, onComment, onChompKeep) {
    if (!ctx)
      return JSON.stringify(this);
    for (const item of this.items) {
      if (!isPair(item))
        throw new Error(`Map items must all be pairs; found ${JSON.stringify(item)} instead`);
    }
    if (!ctx.allNullValues && this.hasAllNullValues(false))
      ctx = Object.assign({}, ctx, { allNullValues: true });
    return stringifyCollection(this, ctx, {
      blockItemPrefix: "",
      flowChars: { start: "{", end: "}" },
      itemIndent: ctx.indent || "",
      onChompKeep,
      onComment
    });
  }
};

// node_modules/yaml/browser/dist/schema/common/map.js
var map = {
  collection: "map",
  default: true,
  nodeClass: YAMLMap,
  tag: "tag:yaml.org,2002:map",
  resolve(map2, onError) {
    if (!isMap(map2))
      onError("Expected a mapping for this tag");
    return map2;
  },
  createNode: (schema4, obj, ctx) => YAMLMap.from(schema4, obj, ctx)
};

// node_modules/yaml/browser/dist/nodes/YAMLSeq.js
var YAMLSeq = class extends Collection {
  static get tagName() {
    return "tag:yaml.org,2002:seq";
  }
  constructor(schema4) {
    super(SEQ, schema4);
    this.items = [];
  }
  add(value) {
    this.items.push(value);
  }
  /**
   * Removes a value from the collection.
   *
   * `key` must contain a representation of an integer for this to succeed.
   * It may be wrapped in a `Scalar`.
   *
   * @returns `true` if the item was found and removed.
   */
  delete(key) {
    const idx = asItemIndex(key);
    if (typeof idx !== "number")
      return false;
    const del = this.items.splice(idx, 1);
    return del.length > 0;
  }
  get(key, keepScalar) {
    const idx = asItemIndex(key);
    if (typeof idx !== "number")
      return void 0;
    const it = this.items[idx];
    return !keepScalar && isScalar(it) ? it.value : it;
  }
  /**
   * Checks if the collection includes a value with the key `key`.
   *
   * `key` must contain a representation of an integer for this to succeed.
   * It may be wrapped in a `Scalar`.
   */
  has(key) {
    const idx = asItemIndex(key);
    return typeof idx === "number" && idx < this.items.length;
  }
  /**
   * Sets a value in this collection. For `!!set`, `value` needs to be a
   * boolean to add/remove the item from the set.
   *
   * If `key` does not contain a representation of an integer, this will throw.
   * It may be wrapped in a `Scalar`.
   */
  set(key, value) {
    const idx = asItemIndex(key);
    if (typeof idx !== "number")
      throw new Error(`Expected a valid index, not ${key}.`);
    const prev = this.items[idx];
    if (isScalar(prev) && isScalarValue(value))
      prev.value = value;
    else
      this.items[idx] = value;
  }
  toJSON(_, ctx) {
    const seq2 = [];
    if (ctx?.onCreate)
      ctx.onCreate(seq2);
    let i = 0;
    for (const item of this.items)
      seq2.push(toJS(item, String(i++), ctx));
    return seq2;
  }
  toString(ctx, onComment, onChompKeep) {
    if (!ctx)
      return JSON.stringify(this);
    return stringifyCollection(this, ctx, {
      blockItemPrefix: "- ",
      flowChars: { start: "[", end: "]" },
      itemIndent: (ctx.indent || "") + "  ",
      onChompKeep,
      onComment
    });
  }
  static from(schema4, obj, ctx) {
    const { replacer } = ctx;
    const seq2 = new this(schema4);
    if (obj && Symbol.iterator in Object(obj)) {
      let i = 0;
      for (let it of obj) {
        if (typeof replacer === "function") {
          const key = obj instanceof Set ? it : String(i++);
          it = replacer.call(obj, key, it);
        }
        seq2.items.push(createNode(it, void 0, ctx));
      }
    }
    return seq2;
  }
};
function asItemIndex(key) {
  let idx = isScalar(key) ? key.value : key;
  if (idx && typeof idx === "string")
    idx = Number(idx);
  return typeof idx === "number" && Number.isInteger(idx) && idx >= 0 ? idx : null;
}

// node_modules/yaml/browser/dist/schema/common/seq.js
var seq = {
  collection: "seq",
  default: true,
  nodeClass: YAMLSeq,
  tag: "tag:yaml.org,2002:seq",
  resolve(seq2, onError) {
    if (!isSeq(seq2))
      onError("Expected a sequence for this tag");
    return seq2;
  },
  createNode: (schema4, obj, ctx) => YAMLSeq.from(schema4, obj, ctx)
};

// node_modules/yaml/browser/dist/schema/common/string.js
var string = {
  identify: (value) => typeof value === "string",
  default: true,
  tag: "tag:yaml.org,2002:str",
  resolve: (str) => str,
  stringify(item, ctx, onComment, onChompKeep) {
    ctx = Object.assign({ actualString: true }, ctx);
    return stringifyString(item, ctx, onComment, onChompKeep);
  }
};

// node_modules/yaml/browser/dist/schema/common/null.js
var nullTag = {
  identify: (value) => value == null,
  createNode: () => new Scalar(null),
  default: true,
  tag: "tag:yaml.org,2002:null",
  test: /^(?:~|[Nn]ull|NULL)?$/,
  resolve: () => new Scalar(null),
  stringify: ({ source }, ctx) => typeof source === "string" && nullTag.test.test(source) ? source : ctx.options.nullStr
};

// node_modules/yaml/browser/dist/schema/core/bool.js
var boolTag = {
  identify: (value) => typeof value === "boolean",
  default: true,
  tag: "tag:yaml.org,2002:bool",
  test: /^(?:[Tt]rue|TRUE|[Ff]alse|FALSE)$/,
  resolve: (str) => new Scalar(str[0] === "t" || str[0] === "T"),
  stringify({ source, value }, ctx) {
    if (source && boolTag.test.test(source)) {
      const sv = source[0] === "t" || source[0] === "T";
      if (value === sv)
        return source;
    }
    return value ? ctx.options.trueStr : ctx.options.falseStr;
  }
};

// node_modules/yaml/browser/dist/stringify/stringifyNumber.js
function stringifyNumber({ format, minFractionDigits, tag, value }) {
  if (typeof value === "bigint")
    return String(value);
  const num = typeof value === "number" ? value : Number(value);
  if (!isFinite(num))
    return isNaN(num) ? ".nan" : num < 0 ? "-.inf" : ".inf";
  let n = Object.is(value, -0) ? "-0" : JSON.stringify(value);
  if (!format && minFractionDigits && (!tag || tag === "tag:yaml.org,2002:float") && /^-?\d/.test(n) && !n.includes("e")) {
    let i = n.indexOf(".");
    if (i < 0) {
      i = n.length;
      n += ".";
    }
    let d = minFractionDigits - (n.length - i - 1);
    while (d-- > 0)
      n += "0";
  }
  return n;
}

// node_modules/yaml/browser/dist/schema/core/float.js
var floatNaN = {
  identify: (value) => typeof value === "number",
  default: true,
  tag: "tag:yaml.org,2002:float",
  test: /^(?:[-+]?\.(?:inf|Inf|INF)|\.nan|\.NaN|\.NAN)$/,
  resolve: (str) => str.slice(-3).toLowerCase() === "nan" ? NaN : str[0] === "-" ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY,
  stringify: stringifyNumber
};
var floatExp = {
  identify: (value) => typeof value === "number",
  default: true,
  tag: "tag:yaml.org,2002:float",
  format: "EXP",
  test: /^[-+]?(?:\.[0-9]+|[0-9]+(?:\.[0-9]*)?)[eE][-+]?[0-9]+$/,
  resolve: (str) => parseFloat(str),
  stringify(node) {
    const num = Number(node.value);
    return isFinite(num) ? num.toExponential() : stringifyNumber(node);
  }
};
var float = {
  identify: (value) => typeof value === "number",
  default: true,
  tag: "tag:yaml.org,2002:float",
  test: /^[-+]?(?:\.[0-9]+|[0-9]+\.[0-9]*)$/,
  resolve(str) {
    const node = new Scalar(parseFloat(str));
    const dot = str.indexOf(".");
    if (dot !== -1 && str[str.length - 1] === "0")
      node.minFractionDigits = str.length - dot - 1;
    return node;
  },
  stringify: stringifyNumber
};

// node_modules/yaml/browser/dist/schema/core/int.js
var intIdentify = (value) => typeof value === "bigint" || Number.isInteger(value);
var intResolve = (str, offset, radix, { intAsBigInt }) => intAsBigInt ? BigInt(str) : parseInt(str.substring(offset), radix);
function intStringify(node, radix, prefix) {
  const { value } = node;
  if (intIdentify(value) && value >= 0)
    return prefix + value.toString(radix);
  return stringifyNumber(node);
}
var intOct = {
  identify: (value) => intIdentify(value) && value >= 0,
  default: true,
  tag: "tag:yaml.org,2002:int",
  format: "OCT",
  test: /^0o[0-7]+$/,
  resolve: (str, _onError, opt) => intResolve(str, 2, 8, opt),
  stringify: (node) => intStringify(node, 8, "0o")
};
var int = {
  identify: intIdentify,
  default: true,
  tag: "tag:yaml.org,2002:int",
  test: /^[-+]?[0-9]+$/,
  resolve: (str, _onError, opt) => intResolve(str, 0, 10, opt),
  stringify: stringifyNumber
};
var intHex = {
  identify: (value) => intIdentify(value) && value >= 0,
  default: true,
  tag: "tag:yaml.org,2002:int",
  format: "HEX",
  test: /^0x[0-9a-fA-F]+$/,
  resolve: (str, _onError, opt) => intResolve(str, 2, 16, opt),
  stringify: (node) => intStringify(node, 16, "0x")
};

// node_modules/yaml/browser/dist/schema/core/schema.js
var schema = [
  map,
  seq,
  string,
  nullTag,
  boolTag,
  intOct,
  int,
  intHex,
  floatNaN,
  floatExp,
  float
];

// node_modules/yaml/browser/dist/schema/json/schema.js
function intIdentify2(value) {
  return typeof value === "bigint" || Number.isInteger(value);
}
var stringifyJSON = ({ value }) => JSON.stringify(value);
var jsonScalars = [
  {
    identify: (value) => typeof value === "string",
    default: true,
    tag: "tag:yaml.org,2002:str",
    resolve: (str) => str,
    stringify: stringifyJSON
  },
  {
    identify: (value) => value == null,
    createNode: () => new Scalar(null),
    default: true,
    tag: "tag:yaml.org,2002:null",
    test: /^null$/,
    resolve: () => null,
    stringify: stringifyJSON
  },
  {
    identify: (value) => typeof value === "boolean",
    default: true,
    tag: "tag:yaml.org,2002:bool",
    test: /^true$|^false$/,
    resolve: (str) => str === "true",
    stringify: stringifyJSON
  },
  {
    identify: intIdentify2,
    default: true,
    tag: "tag:yaml.org,2002:int",
    test: /^-?(?:0|[1-9][0-9]*)$/,
    resolve: (str, _onError, { intAsBigInt }) => intAsBigInt ? BigInt(str) : parseInt(str, 10),
    stringify: ({ value }) => intIdentify2(value) ? value.toString() : JSON.stringify(value)
  },
  {
    identify: (value) => typeof value === "number",
    default: true,
    tag: "tag:yaml.org,2002:float",
    test: /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]*)?(?:[eE][-+]?[0-9]+)?$/,
    resolve: (str) => parseFloat(str),
    stringify: stringifyJSON
  }
];
var jsonError = {
  default: true,
  tag: "",
  test: /^/,
  resolve(str, onError) {
    onError(`Unresolved plain scalar ${JSON.stringify(str)}`);
    return str;
  }
};
var schema2 = [map, seq].concat(jsonScalars, jsonError);

// node_modules/yaml/browser/dist/schema/yaml-1.1/binary.js
var binary = {
  identify: (value) => value instanceof Uint8Array,
  // Buffer inherits from Uint8Array
  default: false,
  tag: "tag:yaml.org,2002:binary",
  /**
   * Returns a Buffer in node and an Uint8Array in browsers
   *
   * To use the resulting buffer as an image, you'll want to do something like:
   *
   *   const blob = new Blob([buffer], { type: 'image/jpeg' })
   *   document.querySelector('#photo').src = URL.createObjectURL(blob)
   */
  resolve(src, onError) {
    if (typeof atob === "function") {
      const str = atob(src.replace(/[\n\r]/g, ""));
      const buffer = new Uint8Array(str.length);
      for (let i = 0; i < str.length; ++i)
        buffer[i] = str.charCodeAt(i);
      return buffer;
    } else {
      onError("This environment does not support reading binary tags; either Buffer or atob is required");
      return src;
    }
  },
  stringify({ comment, type, value }, ctx, onComment, onChompKeep) {
    if (!value)
      return "";
    const buf = value;
    let str;
    if (typeof btoa === "function") {
      let s = "";
      for (let i = 0; i < buf.length; ++i)
        s += String.fromCharCode(buf[i]);
      str = btoa(s);
    } else {
      throw new Error("This environment does not support writing binary tags; either Buffer or btoa is required");
    }
    type ?? (type = Scalar.BLOCK_LITERAL);
    if (type !== Scalar.QUOTE_DOUBLE) {
      const lineWidth = Math.max(ctx.options.lineWidth - ctx.indent.length, ctx.options.minContentWidth);
      const n = Math.ceil(str.length / lineWidth);
      const lines = new Array(n);
      for (let i = 0, o = 0; i < n; ++i, o += lineWidth) {
        lines[i] = str.substr(o, lineWidth);
      }
      str = lines.join(type === Scalar.BLOCK_LITERAL ? "\n" : " ");
    }
    return stringifyString({ comment, type, value: str }, ctx, onComment, onChompKeep);
  }
};

// node_modules/yaml/browser/dist/schema/yaml-1.1/pairs.js
function resolvePairs(seq2, onError) {
  if (isSeq(seq2)) {
    for (let i = 0; i < seq2.items.length; ++i) {
      let item = seq2.items[i];
      if (isPair(item))
        continue;
      else if (isMap(item)) {
        if (item.items.length > 1)
          onError("Each pair must have its own sequence indicator");
        const pair = item.items[0] || new Pair(new Scalar(null));
        if (item.commentBefore)
          pair.key.commentBefore = pair.key.commentBefore ? `${item.commentBefore}
${pair.key.commentBefore}` : item.commentBefore;
        if (item.comment) {
          const cn = pair.value ?? pair.key;
          cn.comment = cn.comment ? `${item.comment}
${cn.comment}` : item.comment;
        }
        item = pair;
      }
      seq2.items[i] = isPair(item) ? item : new Pair(item);
    }
  } else
    onError("Expected a sequence for this tag");
  return seq2;
}
function createPairs(schema4, iterable, ctx) {
  const { replacer } = ctx;
  const pairs2 = new YAMLSeq(schema4);
  pairs2.tag = "tag:yaml.org,2002:pairs";
  let i = 0;
  if (iterable && Symbol.iterator in Object(iterable))
    for (let it of iterable) {
      if (typeof replacer === "function")
        it = replacer.call(iterable, String(i++), it);
      let key, value;
      if (Array.isArray(it)) {
        if (it.length === 2) {
          key = it[0];
          value = it[1];
        } else
          throw new TypeError(`Expected [key, value] tuple: ${it}`);
      } else if (it && it instanceof Object) {
        const keys = Object.keys(it);
        if (keys.length === 1) {
          key = keys[0];
          value = it[key];
        } else {
          throw new TypeError(`Expected tuple with one key, not ${keys.length} keys`);
        }
      } else {
        key = it;
      }
      pairs2.items.push(createPair(key, value, ctx));
    }
  return pairs2;
}
var pairs = {
  collection: "seq",
  default: false,
  tag: "tag:yaml.org,2002:pairs",
  resolve: resolvePairs,
  createNode: createPairs
};

// node_modules/yaml/browser/dist/schema/yaml-1.1/omap.js
var YAMLOMap = class _YAMLOMap extends YAMLSeq {
  constructor() {
    super();
    this.add = YAMLMap.prototype.add.bind(this);
    this.delete = YAMLMap.prototype.delete.bind(this);
    this.get = YAMLMap.prototype.get.bind(this);
    this.has = YAMLMap.prototype.has.bind(this);
    this.set = YAMLMap.prototype.set.bind(this);
    this.tag = _YAMLOMap.tag;
  }
  /**
   * If `ctx` is given, the return type is actually `Map<unknown, unknown>`,
   * but TypeScript won't allow widening the signature of a child method.
   */
  toJSON(_, ctx) {
    if (!ctx)
      return super.toJSON(_);
    const map2 = /* @__PURE__ */ new Map();
    if (ctx?.onCreate)
      ctx.onCreate(map2);
    for (const pair of this.items) {
      let key, value;
      if (isPair(pair)) {
        key = toJS(pair.key, "", ctx);
        value = toJS(pair.value, key, ctx);
      } else {
        key = toJS(pair, "", ctx);
      }
      if (map2.has(key))
        throw new Error("Ordered maps must not include duplicate keys");
      map2.set(key, value);
    }
    return map2;
  }
  static from(schema4, iterable, ctx) {
    const pairs2 = createPairs(schema4, iterable, ctx);
    const omap2 = new this();
    omap2.items = pairs2.items;
    return omap2;
  }
};
YAMLOMap.tag = "tag:yaml.org,2002:omap";
var omap = {
  collection: "seq",
  identify: (value) => value instanceof Map,
  nodeClass: YAMLOMap,
  default: false,
  tag: "tag:yaml.org,2002:omap",
  resolve(seq2, onError) {
    const pairs2 = resolvePairs(seq2, onError);
    const seenKeys = [];
    for (const { key } of pairs2.items) {
      if (isScalar(key)) {
        if (seenKeys.includes(key.value)) {
          onError(`Ordered maps must not include duplicate keys: ${key.value}`);
        } else {
          seenKeys.push(key.value);
        }
      }
    }
    return Object.assign(new YAMLOMap(), pairs2);
  },
  createNode: (schema4, iterable, ctx) => YAMLOMap.from(schema4, iterable, ctx)
};

// node_modules/yaml/browser/dist/schema/yaml-1.1/bool.js
function boolStringify({ value, source }, ctx) {
  const boolObj = value ? trueTag : falseTag;
  if (source && boolObj.test.test(source))
    return source;
  return value ? ctx.options.trueStr : ctx.options.falseStr;
}
var trueTag = {
  identify: (value) => value === true,
  default: true,
  tag: "tag:yaml.org,2002:bool",
  test: /^(?:Y|y|[Yy]es|YES|[Tt]rue|TRUE|[Oo]n|ON)$/,
  resolve: () => new Scalar(true),
  stringify: boolStringify
};
var falseTag = {
  identify: (value) => value === false,
  default: true,
  tag: "tag:yaml.org,2002:bool",
  test: /^(?:N|n|[Nn]o|NO|[Ff]alse|FALSE|[Oo]ff|OFF)$/,
  resolve: () => new Scalar(false),
  stringify: boolStringify
};

// node_modules/yaml/browser/dist/schema/yaml-1.1/float.js
var floatNaN2 = {
  identify: (value) => typeof value === "number",
  default: true,
  tag: "tag:yaml.org,2002:float",
  test: /^(?:[-+]?\.(?:inf|Inf|INF)|\.nan|\.NaN|\.NAN)$/,
  resolve: (str) => str.slice(-3).toLowerCase() === "nan" ? NaN : str[0] === "-" ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY,
  stringify: stringifyNumber
};
var floatExp2 = {
  identify: (value) => typeof value === "number",
  default: true,
  tag: "tag:yaml.org,2002:float",
  format: "EXP",
  test: /^[-+]?(?:[0-9][0-9_]*)?(?:\.[0-9_]*)?[eE][-+]?[0-9]+$/,
  resolve: (str) => parseFloat(str.replace(/_/g, "")),
  stringify(node) {
    const num = Number(node.value);
    return isFinite(num) ? num.toExponential() : stringifyNumber(node);
  }
};
var float2 = {
  identify: (value) => typeof value === "number",
  default: true,
  tag: "tag:yaml.org,2002:float",
  test: /^[-+]?(?:[0-9][0-9_]*)?\.[0-9_]*$/,
  resolve(str) {
    const node = new Scalar(parseFloat(str.replace(/_/g, "")));
    const dot = str.indexOf(".");
    if (dot !== -1) {
      const f = str.substring(dot + 1).replace(/_/g, "");
      if (f[f.length - 1] === "0")
        node.minFractionDigits = f.length;
    }
    return node;
  },
  stringify: stringifyNumber
};

// node_modules/yaml/browser/dist/schema/yaml-1.1/int.js
var intIdentify3 = (value) => typeof value === "bigint" || Number.isInteger(value);
function intResolve2(str, offset, radix, { intAsBigInt }) {
  const sign = str[0];
  if (sign === "-" || sign === "+")
    offset += 1;
  str = str.substring(offset).replace(/_/g, "");
  if (intAsBigInt) {
    switch (radix) {
      case 2:
        str = `0b${str}`;
        break;
      case 8:
        str = `0o${str}`;
        break;
      case 16:
        str = `0x${str}`;
        break;
    }
    const n2 = BigInt(str);
    return sign === "-" ? BigInt(-1) * n2 : n2;
  }
  const n = parseInt(str, radix);
  return sign === "-" ? -1 * n : n;
}
function intStringify2(node, radix, prefix) {
  const { value } = node;
  if (intIdentify3(value)) {
    const str = value.toString(radix);
    return value < 0 ? "-" + prefix + str.substr(1) : prefix + str;
  }
  return stringifyNumber(node);
}
var intBin = {
  identify: intIdentify3,
  default: true,
  tag: "tag:yaml.org,2002:int",
  format: "BIN",
  test: /^[-+]?0b[0-1_]+$/,
  resolve: (str, _onError, opt) => intResolve2(str, 2, 2, opt),
  stringify: (node) => intStringify2(node, 2, "0b")
};
var intOct2 = {
  identify: intIdentify3,
  default: true,
  tag: "tag:yaml.org,2002:int",
  format: "OCT",
  test: /^[-+]?0[0-7_]+$/,
  resolve: (str, _onError, opt) => intResolve2(str, 1, 8, opt),
  stringify: (node) => intStringify2(node, 8, "0")
};
var int2 = {
  identify: intIdentify3,
  default: true,
  tag: "tag:yaml.org,2002:int",
  test: /^[-+]?[0-9][0-9_]*$/,
  resolve: (str, _onError, opt) => intResolve2(str, 0, 10, opt),
  stringify: stringifyNumber
};
var intHex2 = {
  identify: intIdentify3,
  default: true,
  tag: "tag:yaml.org,2002:int",
  format: "HEX",
  test: /^[-+]?0x[0-9a-fA-F_]+$/,
  resolve: (str, _onError, opt) => intResolve2(str, 2, 16, opt),
  stringify: (node) => intStringify2(node, 16, "0x")
};

// node_modules/yaml/browser/dist/schema/yaml-1.1/set.js
var YAMLSet = class _YAMLSet extends YAMLMap {
  constructor(schema4) {
    super(schema4);
    this.tag = _YAMLSet.tag;
  }
  add(key) {
    let pair;
    if (isPair(key))
      pair = key;
    else if (key && typeof key === "object" && "key" in key && "value" in key && key.value === null)
      pair = new Pair(key.key, null);
    else
      pair = new Pair(key, null);
    const prev = findPair(this.items, pair.key);
    if (!prev)
      this.items.push(pair);
  }
  /**
   * If `keepPair` is `true`, returns the Pair matching `key`.
   * Otherwise, returns the value of that Pair's key.
   */
  get(key, keepPair) {
    const pair = findPair(this.items, key);
    return !keepPair && isPair(pair) ? isScalar(pair.key) ? pair.key.value : pair.key : pair;
  }
  set(key, value) {
    if (typeof value !== "boolean")
      throw new Error(`Expected boolean value for set(key, value) in a YAML set, not ${typeof value}`);
    const prev = findPair(this.items, key);
    if (prev && !value) {
      this.items.splice(this.items.indexOf(prev), 1);
    } else if (!prev && value) {
      this.items.push(new Pair(key));
    }
  }
  toJSON(_, ctx) {
    return super.toJSON(_, ctx, Set);
  }
  toString(ctx, onComment, onChompKeep) {
    if (!ctx)
      return JSON.stringify(this);
    if (this.hasAllNullValues(true))
      return super.toString(Object.assign({}, ctx, { allNullValues: true }), onComment, onChompKeep);
    else
      throw new Error("Set items must all have null values");
  }
  static from(schema4, iterable, ctx) {
    const { replacer } = ctx;
    const set2 = new this(schema4);
    if (iterable && Symbol.iterator in Object(iterable))
      for (let value of iterable) {
        if (typeof replacer === "function")
          value = replacer.call(iterable, value, value);
        set2.items.push(createPair(value, null, ctx));
      }
    return set2;
  }
};
YAMLSet.tag = "tag:yaml.org,2002:set";
var set = {
  collection: "map",
  identify: (value) => value instanceof Set,
  nodeClass: YAMLSet,
  default: false,
  tag: "tag:yaml.org,2002:set",
  createNode: (schema4, iterable, ctx) => YAMLSet.from(schema4, iterable, ctx),
  resolve(map2, onError) {
    if (isMap(map2)) {
      if (map2.hasAllNullValues(true))
        return Object.assign(new YAMLSet(), map2);
      else
        onError("Set items must all have null values");
    } else
      onError("Expected a mapping for this tag");
    return map2;
  }
};

// node_modules/yaml/browser/dist/schema/yaml-1.1/timestamp.js
function parseSexagesimal(str, asBigInt) {
  const sign = str[0];
  const parts = sign === "-" || sign === "+" ? str.substring(1) : str;
  const num = (n) => asBigInt ? BigInt(n) : Number(n);
  const res = parts.replace(/_/g, "").split(":").reduce((res2, p) => res2 * num(60) + num(p), num(0));
  return sign === "-" ? num(-1) * res : res;
}
function stringifySexagesimal(node) {
  let { value } = node;
  let num = (n) => n;
  if (typeof value === "bigint")
    num = (n) => BigInt(n);
  else if (isNaN(value) || !isFinite(value))
    return stringifyNumber(node);
  let sign = "";
  if (value < 0) {
    sign = "-";
    value *= num(-1);
  }
  const _60 = num(60);
  const parts = [value % _60];
  if (value < 60) {
    parts.unshift(0);
  } else {
    value = (value - parts[0]) / _60;
    parts.unshift(value % _60);
    if (value >= 60) {
      value = (value - parts[0]) / _60;
      parts.unshift(value);
    }
  }
  return sign + parts.map((n) => String(n).padStart(2, "0")).join(":").replace(/000000\d*$/, "");
}
var intTime = {
  identify: (value) => typeof value === "bigint" || Number.isInteger(value),
  default: true,
  tag: "tag:yaml.org,2002:int",
  format: "TIME",
  test: /^[-+]?[0-9][0-9_]*(?::[0-5]?[0-9])+$/,
  resolve: (str, _onError, { intAsBigInt }) => parseSexagesimal(str, intAsBigInt),
  stringify: stringifySexagesimal
};
var floatTime = {
  identify: (value) => typeof value === "number",
  default: true,
  tag: "tag:yaml.org,2002:float",
  format: "TIME",
  test: /^[-+]?[0-9][0-9_]*(?::[0-5]?[0-9])+\.[0-9_]*$/,
  resolve: (str) => parseSexagesimal(str, false),
  stringify: stringifySexagesimal
};
var timestamp = {
  identify: (value) => value instanceof Date,
  default: true,
  tag: "tag:yaml.org,2002:timestamp",
  // If the time zone is omitted, the timestamp is assumed to be specified in UTC. The time part
  // may be omitted altogether, resulting in a date format. In such a case, the time part is
  // assumed to be 00:00:00Z (start of day, UTC).
  test: RegExp("^([0-9]{4})-([0-9]{1,2})-([0-9]{1,2})(?:(?:t|T|[ \\t]+)([0-9]{1,2}):([0-9]{1,2}):([0-9]{1,2}(\\.[0-9]+)?)(?:[ \\t]*(Z|[-+][012]?[0-9](?::[0-9]{2})?))?)?$"),
  resolve(str) {
    const match = str.match(timestamp.test);
    if (!match)
      throw new Error("!!timestamp expects a date, starting with yyyy-mm-dd");
    const [, year, month, day, hour, minute, second] = match.map(Number);
    const millisec = match[7] ? Number((match[7] + "00").substr(1, 3)) : 0;
    let date = Date.UTC(year, month - 1, day, hour || 0, minute || 0, second || 0, millisec);
    const tz = match[8];
    if (tz && tz !== "Z") {
      let d = parseSexagesimal(tz, false);
      if (Math.abs(d) < 30)
        d *= 60;
      date -= 6e4 * d;
    }
    return new Date(date);
  },
  stringify: ({ value }) => value?.toISOString().replace(/(T00:00:00)?\.000Z$/, "") ?? ""
};

// node_modules/yaml/browser/dist/schema/yaml-1.1/schema.js
var schema3 = [
  map,
  seq,
  string,
  nullTag,
  trueTag,
  falseTag,
  intBin,
  intOct2,
  int2,
  intHex2,
  floatNaN2,
  floatExp2,
  float2,
  binary,
  merge,
  omap,
  pairs,
  set,
  intTime,
  floatTime,
  timestamp
];

// node_modules/yaml/browser/dist/schema/tags.js
var schemas = /* @__PURE__ */ new Map([
  ["core", schema],
  ["failsafe", [map, seq, string]],
  ["json", schema2],
  ["yaml11", schema3],
  ["yaml-1.1", schema3]
]);
var tagsByName = {
  binary,
  bool: boolTag,
  float,
  floatExp,
  floatNaN,
  floatTime,
  int,
  intHex,
  intOct,
  intTime,
  map,
  merge,
  null: nullTag,
  omap,
  pairs,
  seq,
  set,
  timestamp
};
var coreKnownTags = {
  "tag:yaml.org,2002:binary": binary,
  "tag:yaml.org,2002:merge": merge,
  "tag:yaml.org,2002:omap": omap,
  "tag:yaml.org,2002:pairs": pairs,
  "tag:yaml.org,2002:set": set,
  "tag:yaml.org,2002:timestamp": timestamp
};
function getTags(customTags, schemaName, addMergeTag) {
  const schemaTags = schemas.get(schemaName);
  if (schemaTags && !customTags) {
    return addMergeTag && !schemaTags.includes(merge) ? schemaTags.concat(merge) : schemaTags.slice();
  }
  let tags = schemaTags;
  if (!tags) {
    if (Array.isArray(customTags))
      tags = [];
    else {
      const keys = Array.from(schemas.keys()).filter((key) => key !== "yaml11").map((key) => JSON.stringify(key)).join(", ");
      throw new Error(`Unknown schema "${schemaName}"; use one of ${keys} or define customTags array`);
    }
  }
  if (Array.isArray(customTags)) {
    for (const tag of customTags)
      tags = tags.concat(tag);
  } else if (typeof customTags === "function") {
    tags = customTags(tags.slice());
  }
  if (addMergeTag)
    tags = tags.concat(merge);
  return tags.reduce((tags2, tag) => {
    const tagObj = typeof tag === "string" ? tagsByName[tag] : tag;
    if (!tagObj) {
      const tagName = JSON.stringify(tag);
      const keys = Object.keys(tagsByName).map((key) => JSON.stringify(key)).join(", ");
      throw new Error(`Unknown custom tag ${tagName}; use one of ${keys}`);
    }
    if (!tags2.includes(tagObj))
      tags2.push(tagObj);
    return tags2;
  }, []);
}

// node_modules/yaml/browser/dist/schema/Schema.js
var sortMapEntriesByKey = (a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
var Schema = class _Schema {
  constructor({ compat, customTags, merge: merge2, resolveKnownTags, schema: schema4, sortMapEntries, toStringDefaults }) {
    this.compat = Array.isArray(compat) ? getTags(compat, "compat") : compat ? getTags(null, compat) : null;
    this.name = typeof schema4 === "string" && schema4 || "core";
    this.knownTags = resolveKnownTags ? coreKnownTags : {};
    this.tags = getTags(customTags, this.name, merge2);
    this.toStringOptions = toStringDefaults ?? null;
    Object.defineProperty(this, MAP, { value: map });
    Object.defineProperty(this, SCALAR, { value: string });
    Object.defineProperty(this, SEQ, { value: seq });
    this.sortMapEntries = typeof sortMapEntries === "function" ? sortMapEntries : sortMapEntries === true ? sortMapEntriesByKey : null;
  }
  clone() {
    const copy = Object.create(_Schema.prototype, Object.getOwnPropertyDescriptors(this));
    copy.tags = this.tags.slice();
    return copy;
  }
};

// node_modules/yaml/browser/dist/stringify/stringifyDocument.js
function stringifyDocument(doc, options) {
  const lines = [];
  let hasDirectives = options.directives === true;
  if (options.directives !== false && doc.directives) {
    const dir = doc.directives.toString(doc);
    if (dir) {
      lines.push(dir);
      hasDirectives = true;
    } else if (doc.directives.docStart)
      hasDirectives = true;
  }
  if (hasDirectives)
    lines.push("---");
  const ctx = createStringifyContext(doc, options);
  const { commentString } = ctx.options;
  if (doc.commentBefore) {
    if (lines.length !== 1)
      lines.unshift("");
    const cs = commentString(doc.commentBefore);
    lines.unshift(indentComment(cs, ""));
  }
  let chompKeep = false;
  let contentComment = null;
  if (doc.contents) {
    if (isNode(doc.contents)) {
      if (doc.contents.spaceBefore && hasDirectives)
        lines.push("");
      if (doc.contents.commentBefore) {
        const cs = commentString(doc.contents.commentBefore);
        lines.push(indentComment(cs, ""));
      }
      ctx.forceBlockIndent = !!doc.comment;
      contentComment = doc.contents.comment;
    }
    const onChompKeep = contentComment ? void 0 : () => chompKeep = true;
    let body = stringify(doc.contents, ctx, () => contentComment = null, onChompKeep);
    if (contentComment)
      body += lineComment(body, "", commentString(contentComment));
    if ((body[0] === "|" || body[0] === ">") && lines[lines.length - 1] === "---") {
      lines[lines.length - 1] = `--- ${body}`;
    } else
      lines.push(body);
  } else {
    lines.push(stringify(doc.contents, ctx));
  }
  if (doc.directives?.docEnd) {
    if (doc.comment) {
      const cs = commentString(doc.comment);
      if (cs.includes("\n")) {
        lines.push("...");
        lines.push(indentComment(cs, ""));
      } else {
        lines.push(`... ${cs}`);
      }
    } else {
      lines.push("...");
    }
  } else {
    let dc = doc.comment;
    if (dc && chompKeep)
      dc = dc.replace(/^\n+/, "");
    if (dc) {
      if ((!chompKeep || contentComment) && lines[lines.length - 1] !== "")
        lines.push("");
      lines.push(indentComment(commentString(dc), ""));
    }
  }
  return lines.join("\n") + "\n";
}

// node_modules/yaml/browser/dist/doc/Document.js
var Document = class _Document {
  constructor(value, replacer, options) {
    this.commentBefore = null;
    this.comment = null;
    this.errors = [];
    this.warnings = [];
    Object.defineProperty(this, NODE_TYPE, { value: DOC });
    let _replacer = null;
    if (typeof replacer === "function" || Array.isArray(replacer)) {
      _replacer = replacer;
    } else if (options === void 0 && replacer) {
      options = replacer;
      replacer = void 0;
    }
    const opt = Object.assign({
      intAsBigInt: false,
      keepSourceTokens: false,
      logLevel: "warn",
      prettyErrors: true,
      strict: true,
      stringKeys: false,
      uniqueKeys: true,
      version: "1.2"
    }, options);
    this.options = opt;
    let { version } = opt;
    if (options?._directives) {
      this.directives = options._directives.atDocument();
      if (this.directives.yaml.explicit)
        version = this.directives.yaml.version;
    } else
      this.directives = new Directives({ version });
    this.setSchema(version, options);
    this.contents = value === void 0 ? null : this.createNode(value, _replacer, options);
  }
  /**
   * Create a deep copy of this Document and its contents.
   *
   * Custom Node values that inherit from `Object` still refer to their original instances.
   */
  clone() {
    const copy = Object.create(_Document.prototype, {
      [NODE_TYPE]: { value: DOC }
    });
    copy.commentBefore = this.commentBefore;
    copy.comment = this.comment;
    copy.errors = this.errors.slice();
    copy.warnings = this.warnings.slice();
    copy.options = Object.assign({}, this.options);
    if (this.directives)
      copy.directives = this.directives.clone();
    copy.schema = this.schema.clone();
    copy.contents = isNode(this.contents) ? this.contents.clone(copy.schema) : this.contents;
    if (this.range)
      copy.range = this.range.slice();
    return copy;
  }
  /** Adds a value to the document. */
  add(value) {
    if (assertCollection(this.contents))
      this.contents.add(value);
  }
  /** Adds a value to the document. */
  addIn(path, value) {
    if (assertCollection(this.contents))
      this.contents.addIn(path, value);
  }
  /**
   * Create a new `Alias` node, ensuring that the target `node` has the required anchor.
   *
   * If `node` already has an anchor, `name` is ignored.
   * Otherwise, the `node.anchor` value will be set to `name`,
   * or if an anchor with that name is already present in the document,
   * `name` will be used as a prefix for a new unique anchor.
   * If `name` is undefined, the generated anchor will use 'a' as a prefix.
   */
  createAlias(node, name) {
    if (!node.anchor) {
      const prev = anchorNames(this);
      node.anchor = // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
      !name || prev.has(name) ? findNewAnchor(name || "a", prev) : name;
    }
    return new Alias(node.anchor);
  }
  createNode(value, replacer, options) {
    let _replacer = void 0;
    if (typeof replacer === "function") {
      value = replacer.call({ "": value }, "", value);
      _replacer = replacer;
    } else if (Array.isArray(replacer)) {
      const keyToStr = (v) => typeof v === "number" || v instanceof String || v instanceof Number;
      const asStr = replacer.filter(keyToStr).map(String);
      if (asStr.length > 0)
        replacer = replacer.concat(asStr);
      _replacer = replacer;
    } else if (options === void 0 && replacer) {
      options = replacer;
      replacer = void 0;
    }
    const { aliasDuplicateObjects, anchorPrefix, flow, keepUndefined, onTagObj, tag } = options ?? {};
    const { onAnchor, setAnchors, sourceObjects } = createNodeAnchors(
      this,
      // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
      anchorPrefix || "a"
    );
    const ctx = {
      aliasDuplicateObjects: aliasDuplicateObjects ?? true,
      keepUndefined: keepUndefined ?? false,
      onAnchor,
      onTagObj,
      replacer: _replacer,
      schema: this.schema,
      sourceObjects
    };
    const node = createNode(value, tag, ctx);
    if (flow && isCollection(node))
      node.flow = true;
    setAnchors();
    return node;
  }
  /**
   * Convert a key and a value into a `Pair` using the current schema,
   * recursively wrapping all values as `Scalar` or `Collection` nodes.
   */
  createPair(key, value, options = {}) {
    const k = this.createNode(key, null, options);
    const v = this.createNode(value, null, options);
    return new Pair(k, v);
  }
  /**
   * Removes a value from the document.
   * @returns `true` if the item was found and removed.
   */
  delete(key) {
    return assertCollection(this.contents) ? this.contents.delete(key) : false;
  }
  /**
   * Removes a value from the document.
   * @returns `true` if the item was found and removed.
   */
  deleteIn(path) {
    if (isEmptyPath(path)) {
      if (this.contents == null)
        return false;
      this.contents = null;
      return true;
    }
    return assertCollection(this.contents) ? this.contents.deleteIn(path) : false;
  }
  /**
   * Returns item at `key`, or `undefined` if not found. By default unwraps
   * scalar values from their surrounding node; to disable set `keepScalar` to
   * `true` (collections are always returned intact).
   */
  get(key, keepScalar) {
    return isCollection(this.contents) ? this.contents.get(key, keepScalar) : void 0;
  }
  /**
   * Returns item at `path`, or `undefined` if not found. By default unwraps
   * scalar values from their surrounding node; to disable set `keepScalar` to
   * `true` (collections are always returned intact).
   */
  getIn(path, keepScalar) {
    if (isEmptyPath(path))
      return !keepScalar && isScalar(this.contents) ? this.contents.value : this.contents;
    return isCollection(this.contents) ? this.contents.getIn(path, keepScalar) : void 0;
  }
  /**
   * Checks if the document includes a value with the key `key`.
   */
  has(key) {
    return isCollection(this.contents) ? this.contents.has(key) : false;
  }
  /**
   * Checks if the document includes a value at `path`.
   */
  hasIn(path) {
    if (isEmptyPath(path))
      return this.contents !== void 0;
    return isCollection(this.contents) ? this.contents.hasIn(path) : false;
  }
  /**
   * Sets a value in this document. For `!!set`, `value` needs to be a
   * boolean to add/remove the item from the set.
   */
  set(key, value) {
    if (this.contents == null) {
      this.contents = collectionFromPath(this.schema, [key], value);
    } else if (assertCollection(this.contents)) {
      this.contents.set(key, value);
    }
  }
  /**
   * Sets a value in this document. For `!!set`, `value` needs to be a
   * boolean to add/remove the item from the set.
   */
  setIn(path, value) {
    if (isEmptyPath(path)) {
      this.contents = value;
    } else if (this.contents == null) {
      this.contents = collectionFromPath(this.schema, Array.from(path), value);
    } else if (assertCollection(this.contents)) {
      this.contents.setIn(path, value);
    }
  }
  /**
   * Change the YAML version and schema used by the document.
   * A `null` version disables support for directives, explicit tags, anchors, and aliases.
   * It also requires the `schema` option to be given as a `Schema` instance value.
   *
   * Overrides all previously set schema options.
   */
  setSchema(version, options = {}) {
    if (typeof version === "number")
      version = String(version);
    let opt;
    switch (version) {
      case "1.1":
        if (this.directives)
          this.directives.yaml.version = "1.1";
        else
          this.directives = new Directives({ version: "1.1" });
        opt = { resolveKnownTags: false, schema: "yaml-1.1" };
        break;
      case "1.2":
      case "next":
        if (this.directives)
          this.directives.yaml.version = version;
        else
          this.directives = new Directives({ version });
        opt = { resolveKnownTags: true, schema: "core" };
        break;
      case null:
        if (this.directives)
          delete this.directives;
        opt = null;
        break;
      default: {
        const sv = JSON.stringify(version);
        throw new Error(`Expected '1.1', '1.2' or null as first argument, but found: ${sv}`);
      }
    }
    if (options.schema instanceof Object)
      this.schema = options.schema;
    else if (opt)
      this.schema = new Schema(Object.assign(opt, options));
    else
      throw new Error(`With a null YAML version, the { schema: Schema } option is required`);
  }
  // json & jsonArg are only used from toJSON()
  toJS({ json, jsonArg, mapAsMap, maxAliasCount, onAnchor, reviver } = {}) {
    const ctx = {
      anchors: /* @__PURE__ */ new Map(),
      doc: this,
      keep: !json,
      mapAsMap: mapAsMap === true,
      mapKeyWarned: false,
      maxAliasCount: typeof maxAliasCount === "number" ? maxAliasCount : 100
    };
    const res = toJS(this.contents, jsonArg ?? "", ctx);
    if (typeof onAnchor === "function")
      for (const { count, res: res2 } of ctx.anchors.values())
        onAnchor(res2, count);
    return typeof reviver === "function" ? applyReviver(reviver, { "": res }, "", res) : res;
  }
  /**
   * A JSON representation of the document `contents`.
   *
   * @param jsonArg Used by `JSON.stringify` to indicate the array index or
   *   property name.
   */
  toJSON(jsonArg, onAnchor) {
    return this.toJS({ json: true, jsonArg, mapAsMap: false, onAnchor });
  }
  /** A YAML representation of the document. */
  toString(options = {}) {
    if (this.errors.length > 0)
      throw new Error("Document with errors cannot be stringified");
    if ("indent" in options && (!Number.isInteger(options.indent) || Number(options.indent) <= 0)) {
      const s = JSON.stringify(options.indent);
      throw new Error(`"indent" option must be a positive integer, not ${s}`);
    }
    return stringifyDocument(this, options);
  }
};
function assertCollection(contents) {
  if (isCollection(contents))
    return true;
  throw new Error("Expected a YAML collection as document contents");
}

// node_modules/yaml/browser/dist/errors.js
var YAMLError = class extends Error {
  constructor(name, pos, code, message) {
    super();
    this.name = name;
    this.code = code;
    this.message = message;
    this.pos = pos;
  }
};
var YAMLParseError = class extends YAMLError {
  constructor(pos, code, message) {
    super("YAMLParseError", pos, code, message);
  }
};
var YAMLWarning = class extends YAMLError {
  constructor(pos, code, message) {
    super("YAMLWarning", pos, code, message);
  }
};
var prettifyError = (src, lc) => (error) => {
  if (error.pos[0] === -1)
    return;
  error.linePos = error.pos.map((pos) => lc.linePos(pos));
  const { line, col } = error.linePos[0];
  error.message += ` at line ${line}, column ${col}`;
  let ci = col - 1;
  let lineStr = src.substring(lc.lineStarts[line - 1], lc.lineStarts[line]).replace(/[\n\r]+$/, "");
  if (ci >= 60 && lineStr.length > 80) {
    const trimStart = Math.min(ci - 39, lineStr.length - 79);
    lineStr = "\u2026" + lineStr.substring(trimStart);
    ci -= trimStart - 1;
  }
  if (lineStr.length > 80)
    lineStr = lineStr.substring(0, 79) + "\u2026";
  if (line > 1 && /^ *$/.test(lineStr.substring(0, ci))) {
    let prev = src.substring(lc.lineStarts[line - 2], lc.lineStarts[line - 1]);
    if (prev.length > 80)
      prev = prev.substring(0, 79) + "\u2026\n";
    lineStr = prev + lineStr;
  }
  if (/[^ ]/.test(lineStr)) {
    let count = 1;
    const end = error.linePos[1];
    if (end?.line === line && end.col > col) {
      count = Math.max(1, Math.min(end.col - col, 80 - ci));
    }
    const pointer = " ".repeat(ci) + "^".repeat(count);
    error.message += `:

${lineStr}
${pointer}
`;
  }
};

// node_modules/yaml/browser/dist/compose/resolve-props.js
function resolveProps(tokens, { flow, indicator, next, offset, onError, parentIndent, startOnNewline }) {
  let spaceBefore = false;
  let atNewline = startOnNewline;
  let hasSpace = startOnNewline;
  let comment = "";
  let commentSep = "";
  let hasNewline = false;
  let reqSpace = false;
  let tab = null;
  let anchor = null;
  let tag = null;
  let newlineAfterProp = null;
  let comma = null;
  let found = null;
  let start = null;
  for (const token of tokens) {
    if (reqSpace) {
      if (token.type !== "space" && token.type !== "newline" && token.type !== "comma")
        onError(token.offset, "MISSING_CHAR", "Tags and anchors must be separated from the next token by white space");
      reqSpace = false;
    }
    if (tab) {
      if (atNewline && token.type !== "comment" && token.type !== "newline") {
        onError(tab, "TAB_AS_INDENT", "Tabs are not allowed as indentation");
      }
      tab = null;
    }
    switch (token.type) {
      case "space":
        if (!flow && (indicator !== "doc-start" || next?.type !== "flow-collection") && token.source.includes("	")) {
          tab = token;
        }
        hasSpace = true;
        break;
      case "comment": {
        if (!hasSpace)
          onError(token, "MISSING_CHAR", "Comments must be separated from other tokens by white space characters");
        const cb = token.source.substring(1) || " ";
        if (!comment)
          comment = cb;
        else
          comment += commentSep + cb;
        commentSep = "";
        atNewline = false;
        break;
      }
      case "newline":
        if (atNewline) {
          if (comment)
            comment += token.source;
          else if (!found || indicator !== "seq-item-ind")
            spaceBefore = true;
        } else
          commentSep += token.source;
        atNewline = true;
        hasNewline = true;
        if (anchor || tag)
          newlineAfterProp = token;
        hasSpace = true;
        break;
      case "anchor":
        if (anchor)
          onError(token, "MULTIPLE_ANCHORS", "A node can have at most one anchor");
        if (token.source.endsWith(":"))
          onError(token.offset + token.source.length - 1, "BAD_ALIAS", "Anchor ending in : is ambiguous", true);
        anchor = token;
        start ?? (start = token.offset);
        atNewline = false;
        hasSpace = false;
        reqSpace = true;
        break;
      case "tag": {
        if (tag)
          onError(token, "MULTIPLE_TAGS", "A node can have at most one tag");
        tag = token;
        start ?? (start = token.offset);
        atNewline = false;
        hasSpace = false;
        reqSpace = true;
        break;
      }
      case indicator:
        if (anchor || tag)
          onError(token, "BAD_PROP_ORDER", `Anchors and tags must be after the ${token.source} indicator`);
        if (found)
          onError(token, "UNEXPECTED_TOKEN", `Unexpected ${token.source} in ${flow ?? "collection"}`);
        found = token;
        atNewline = indicator === "seq-item-ind" || indicator === "explicit-key-ind";
        hasSpace = false;
        break;
      case "comma":
        if (flow) {
          if (comma)
            onError(token, "UNEXPECTED_TOKEN", `Unexpected , in ${flow}`);
          comma = token;
          atNewline = false;
          hasSpace = false;
          break;
        }
      // else fallthrough
      default:
        onError(token, "UNEXPECTED_TOKEN", `Unexpected ${token.type} token`);
        atNewline = false;
        hasSpace = false;
    }
  }
  const last = tokens[tokens.length - 1];
  const end = last ? last.offset + last.source.length : offset;
  if (reqSpace && next && next.type !== "space" && next.type !== "newline" && next.type !== "comma" && (next.type !== "scalar" || next.source !== "")) {
    onError(next.offset, "MISSING_CHAR", "Tags and anchors must be separated from the next token by white space");
  }
  if (tab && (atNewline && tab.indent <= parentIndent || next?.type === "block-map" || next?.type === "block-seq"))
    onError(tab, "TAB_AS_INDENT", "Tabs are not allowed as indentation");
  return {
    comma,
    found,
    spaceBefore,
    comment,
    hasNewline,
    anchor,
    tag,
    newlineAfterProp,
    end,
    start: start ?? end
  };
}

// node_modules/yaml/browser/dist/compose/util-contains-newline.js
function containsNewline(key) {
  if (!key)
    return null;
  switch (key.type) {
    case "alias":
    case "scalar":
    case "double-quoted-scalar":
    case "single-quoted-scalar":
      if (key.source.includes("\n"))
        return true;
      if (key.end) {
        for (const st of key.end)
          if (st.type === "newline")
            return true;
      }
      return false;
    case "flow-collection":
      for (const it of key.items) {
        for (const st of it.start)
          if (st.type === "newline")
            return true;
        if (it.sep) {
          for (const st of it.sep)
            if (st.type === "newline")
              return true;
        }
        if (containsNewline(it.key) || containsNewline(it.value))
          return true;
      }
      return false;
    default:
      return true;
  }
}

// node_modules/yaml/browser/dist/compose/util-flow-indent-check.js
function flowIndentCheck(indent, fc, onError) {
  if (fc?.type === "flow-collection") {
    const end = fc.end[0];
    if (end.indent === indent && (end.source === "]" || end.source === "}") && containsNewline(fc)) {
      const msg = "Flow end indicator should be more indented than parent";
      onError(end, "BAD_INDENT", msg, true);
    }
  }
}

// node_modules/yaml/browser/dist/compose/util-map-includes.js
function mapIncludes(ctx, items, search) {
  const { uniqueKeys } = ctx.options;
  if (uniqueKeys === false)
    return false;
  const isEqual = typeof uniqueKeys === "function" ? uniqueKeys : (a, b) => a === b || isScalar(a) && isScalar(b) && a.value === b.value;
  return items.some((pair) => isEqual(pair.key, search));
}

// node_modules/yaml/browser/dist/compose/resolve-block-map.js
var startColMsg = "All mapping items must start at the same column";
function resolveBlockMap({ composeNode: composeNode2, composeEmptyNode: composeEmptyNode2 }, ctx, bm, onError, tag) {
  const NodeClass = tag?.nodeClass ?? YAMLMap;
  const map2 = new NodeClass(ctx.schema);
  if (ctx.atRoot)
    ctx.atRoot = false;
  let offset = bm.offset;
  let commentEnd = null;
  for (const collItem of bm.items) {
    const { start, key, sep, value } = collItem;
    const keyProps = resolveProps(start, {
      indicator: "explicit-key-ind",
      next: key ?? sep?.[0],
      offset,
      onError,
      parentIndent: bm.indent,
      startOnNewline: true
    });
    const implicitKey = !keyProps.found;
    if (implicitKey) {
      if (key) {
        if (key.type === "block-seq")
          onError(offset, "BLOCK_AS_IMPLICIT_KEY", "A block sequence may not be used as an implicit map key");
        else if ("indent" in key && key.indent !== bm.indent)
          onError(offset, "BAD_INDENT", startColMsg);
      }
      if (!keyProps.anchor && !keyProps.tag && !sep) {
        commentEnd = keyProps.end;
        if (keyProps.comment) {
          if (map2.comment)
            map2.comment += "\n" + keyProps.comment;
          else
            map2.comment = keyProps.comment;
        }
        continue;
      }
      if (keyProps.newlineAfterProp || containsNewline(key)) {
        onError(key ?? start[start.length - 1], "MULTILINE_IMPLICIT_KEY", "Implicit keys need to be on a single line");
      }
    } else if (keyProps.found?.indent !== bm.indent) {
      onError(offset, "BAD_INDENT", startColMsg);
    }
    ctx.atKey = true;
    const keyStart = keyProps.end;
    const keyNode = key ? composeNode2(ctx, key, keyProps, onError) : composeEmptyNode2(ctx, keyStart, start, null, keyProps, onError);
    if (ctx.schema.compat)
      flowIndentCheck(bm.indent, key, onError);
    ctx.atKey = false;
    if (mapIncludes(ctx, map2.items, keyNode))
      onError(keyStart, "DUPLICATE_KEY", "Map keys must be unique");
    const valueProps = resolveProps(sep ?? [], {
      indicator: "map-value-ind",
      next: value,
      offset: keyNode.range[2],
      onError,
      parentIndent: bm.indent,
      startOnNewline: !key || key.type === "block-scalar"
    });
    offset = valueProps.end;
    if (valueProps.found) {
      if (implicitKey) {
        if (value?.type === "block-map" && !valueProps.hasNewline)
          onError(offset, "BLOCK_AS_IMPLICIT_KEY", "Nested mappings are not allowed in compact mappings");
        if (ctx.options.strict && keyProps.start < valueProps.found.offset - 1024)
          onError(keyNode.range, "KEY_OVER_1024_CHARS", "The : indicator must be at most 1024 chars after the start of an implicit block mapping key");
      }
      const valueNode = value ? composeNode2(ctx, value, valueProps, onError) : composeEmptyNode2(ctx, offset, sep, null, valueProps, onError);
      if (ctx.schema.compat)
        flowIndentCheck(bm.indent, value, onError);
      offset = valueNode.range[2];
      const pair = new Pair(keyNode, valueNode);
      if (ctx.options.keepSourceTokens)
        pair.srcToken = collItem;
      map2.items.push(pair);
    } else {
      if (implicitKey)
        onError(keyNode.range, "MISSING_CHAR", "Implicit map keys need to be followed by map values");
      if (valueProps.comment) {
        if (keyNode.comment)
          keyNode.comment += "\n" + valueProps.comment;
        else
          keyNode.comment = valueProps.comment;
      }
      const pair = new Pair(keyNode);
      if (ctx.options.keepSourceTokens)
        pair.srcToken = collItem;
      map2.items.push(pair);
    }
  }
  if (commentEnd && commentEnd < offset)
    onError(commentEnd, "IMPOSSIBLE", "Map comment with trailing content");
  map2.range = [bm.offset, offset, commentEnd ?? offset];
  return map2;
}

// node_modules/yaml/browser/dist/compose/resolve-block-seq.js
function resolveBlockSeq({ composeNode: composeNode2, composeEmptyNode: composeEmptyNode2 }, ctx, bs, onError, tag) {
  const NodeClass = tag?.nodeClass ?? YAMLSeq;
  const seq2 = new NodeClass(ctx.schema);
  if (ctx.atRoot)
    ctx.atRoot = false;
  if (ctx.atKey)
    ctx.atKey = false;
  let offset = bs.offset;
  let commentEnd = null;
  for (const { start, value } of bs.items) {
    const props = resolveProps(start, {
      indicator: "seq-item-ind",
      next: value,
      offset,
      onError,
      parentIndent: bs.indent,
      startOnNewline: true
    });
    if (!props.found) {
      if (props.anchor || props.tag || value) {
        if (value?.type === "block-seq")
          onError(props.end, "BAD_INDENT", "All sequence items must start at the same column");
        else
          onError(offset, "MISSING_CHAR", "Sequence item without - indicator");
      } else {
        commentEnd = props.end;
        if (props.comment)
          seq2.comment = props.comment;
        continue;
      }
    }
    const node = value ? composeNode2(ctx, value, props, onError) : composeEmptyNode2(ctx, props.end, start, null, props, onError);
    if (ctx.schema.compat)
      flowIndentCheck(bs.indent, value, onError);
    offset = node.range[2];
    seq2.items.push(node);
  }
  seq2.range = [bs.offset, offset, commentEnd ?? offset];
  return seq2;
}

// node_modules/yaml/browser/dist/compose/resolve-end.js
function resolveEnd(end, offset, reqSpace, onError) {
  let comment = "";
  if (end) {
    let hasSpace = false;
    let sep = "";
    for (const token of end) {
      const { source, type } = token;
      switch (type) {
        case "space":
          hasSpace = true;
          break;
        case "comment": {
          if (reqSpace && !hasSpace)
            onError(token, "MISSING_CHAR", "Comments must be separated from other tokens by white space characters");
          const cb = source.substring(1) || " ";
          if (!comment)
            comment = cb;
          else
            comment += sep + cb;
          sep = "";
          break;
        }
        case "newline":
          if (comment)
            sep += source;
          hasSpace = true;
          break;
        default:
          onError(token, "UNEXPECTED_TOKEN", `Unexpected ${type} at node end`);
      }
      offset += source.length;
    }
  }
  return { comment, offset };
}

// node_modules/yaml/browser/dist/compose/resolve-flow-collection.js
var blockMsg = "Block collections are not allowed within flow collections";
var isBlock = (token) => token && (token.type === "block-map" || token.type === "block-seq");
function resolveFlowCollection({ composeNode: composeNode2, composeEmptyNode: composeEmptyNode2 }, ctx, fc, onError, tag) {
  const isMap2 = fc.start.source === "{";
  const fcName = isMap2 ? "flow map" : "flow sequence";
  const NodeClass = tag?.nodeClass ?? (isMap2 ? YAMLMap : YAMLSeq);
  const coll = new NodeClass(ctx.schema);
  coll.flow = true;
  const atRoot = ctx.atRoot;
  if (atRoot)
    ctx.atRoot = false;
  if (ctx.atKey)
    ctx.atKey = false;
  let offset = fc.offset + fc.start.source.length;
  for (let i = 0; i < fc.items.length; ++i) {
    const collItem = fc.items[i];
    const { start, key, sep, value } = collItem;
    const props = resolveProps(start, {
      flow: fcName,
      indicator: "explicit-key-ind",
      next: key ?? sep?.[0],
      offset,
      onError,
      parentIndent: fc.indent,
      startOnNewline: false
    });
    if (!props.found) {
      if (!props.anchor && !props.tag && !sep && !value) {
        if (i === 0 && props.comma)
          onError(props.comma, "UNEXPECTED_TOKEN", `Unexpected , in ${fcName}`);
        else if (i < fc.items.length - 1)
          onError(props.start, "UNEXPECTED_TOKEN", `Unexpected empty item in ${fcName}`);
        if (props.comment) {
          if (coll.comment)
            coll.comment += "\n" + props.comment;
          else
            coll.comment = props.comment;
        }
        offset = props.end;
        continue;
      }
      if (!isMap2 && ctx.options.strict && containsNewline(key))
        onError(
          key,
          // checked by containsNewline()
          "MULTILINE_IMPLICIT_KEY",
          "Implicit keys of flow sequence pairs need to be on a single line"
        );
    }
    if (i === 0) {
      if (props.comma)
        onError(props.comma, "UNEXPECTED_TOKEN", `Unexpected , in ${fcName}`);
    } else {
      if (!props.comma)
        onError(props.start, "MISSING_CHAR", `Missing , between ${fcName} items`);
      if (props.comment) {
        let prevItemComment = "";
        loop: for (const st of start) {
          switch (st.type) {
            case "comma":
            case "space":
              break;
            case "comment":
              prevItemComment = st.source.substring(1);
              break loop;
            default:
              break loop;
          }
        }
        if (prevItemComment) {
          let prev = coll.items[coll.items.length - 1];
          if (isPair(prev))
            prev = prev.value ?? prev.key;
          if (prev.comment)
            prev.comment += "\n" + prevItemComment;
          else
            prev.comment = prevItemComment;
          props.comment = props.comment.substring(prevItemComment.length + 1);
        }
      }
    }
    if (!isMap2 && !sep && !props.found) {
      const valueNode = value ? composeNode2(ctx, value, props, onError) : composeEmptyNode2(ctx, props.end, sep, null, props, onError);
      coll.items.push(valueNode);
      offset = valueNode.range[2];
      if (isBlock(value))
        onError(valueNode.range, "BLOCK_IN_FLOW", blockMsg);
    } else {
      ctx.atKey = true;
      const keyStart = props.end;
      const keyNode = key ? composeNode2(ctx, key, props, onError) : composeEmptyNode2(ctx, keyStart, start, null, props, onError);
      if (isBlock(key))
        onError(keyNode.range, "BLOCK_IN_FLOW", blockMsg);
      ctx.atKey = false;
      const valueProps = resolveProps(sep ?? [], {
        flow: fcName,
        indicator: "map-value-ind",
        next: value,
        offset: keyNode.range[2],
        onError,
        parentIndent: fc.indent,
        startOnNewline: false
      });
      if (valueProps.found) {
        if (!isMap2 && !props.found && ctx.options.strict) {
          if (sep)
            for (const st of sep) {
              if (st === valueProps.found)
                break;
              if (st.type === "newline") {
                onError(st, "MULTILINE_IMPLICIT_KEY", "Implicit keys of flow sequence pairs need to be on a single line");
                break;
              }
            }
          if (props.start < valueProps.found.offset - 1024)
            onError(valueProps.found, "KEY_OVER_1024_CHARS", "The : indicator must be at most 1024 chars after the start of an implicit flow sequence key");
        }
      } else if (value) {
        if ("source" in value && value.source?.[0] === ":")
          onError(value, "MISSING_CHAR", `Missing space after : in ${fcName}`);
        else
          onError(valueProps.start, "MISSING_CHAR", `Missing , or : between ${fcName} items`);
      }
      const valueNode = value ? composeNode2(ctx, value, valueProps, onError) : valueProps.found ? composeEmptyNode2(ctx, valueProps.end, sep, null, valueProps, onError) : null;
      if (valueNode) {
        if (isBlock(value))
          onError(valueNode.range, "BLOCK_IN_FLOW", blockMsg);
      } else if (valueProps.comment) {
        if (keyNode.comment)
          keyNode.comment += "\n" + valueProps.comment;
        else
          keyNode.comment = valueProps.comment;
      }
      const pair = new Pair(keyNode, valueNode);
      if (ctx.options.keepSourceTokens)
        pair.srcToken = collItem;
      if (isMap2) {
        const map2 = coll;
        if (mapIncludes(ctx, map2.items, keyNode))
          onError(keyStart, "DUPLICATE_KEY", "Map keys must be unique");
        map2.items.push(pair);
      } else {
        const map2 = new YAMLMap(ctx.schema);
        map2.flow = true;
        map2.items.push(pair);
        const endRange = (valueNode ?? keyNode).range;
        map2.range = [keyNode.range[0], endRange[1], endRange[2]];
        coll.items.push(map2);
      }
      offset = valueNode ? valueNode.range[2] : valueProps.end;
    }
  }
  const expectedEnd = isMap2 ? "}" : "]";
  const [ce, ...ee] = fc.end;
  let cePos = offset;
  if (ce?.source === expectedEnd)
    cePos = ce.offset + ce.source.length;
  else {
    const name = fcName[0].toUpperCase() + fcName.substring(1);
    const msg = atRoot ? `${name} must end with a ${expectedEnd}` : `${name} in block collection must be sufficiently indented and end with a ${expectedEnd}`;
    onError(offset, atRoot ? "MISSING_CHAR" : "BAD_INDENT", msg);
    if (ce && ce.source.length !== 1)
      ee.unshift(ce);
  }
  if (ee.length > 0) {
    const end = resolveEnd(ee, cePos, ctx.options.strict, onError);
    if (end.comment) {
      if (coll.comment)
        coll.comment += "\n" + end.comment;
      else
        coll.comment = end.comment;
    }
    coll.range = [fc.offset, cePos, end.offset];
  } else {
    coll.range = [fc.offset, cePos, cePos];
  }
  return coll;
}

// node_modules/yaml/browser/dist/compose/compose-collection.js
function resolveCollection(CN2, ctx, token, onError, tagName, tag) {
  const coll = token.type === "block-map" ? resolveBlockMap(CN2, ctx, token, onError, tag) : token.type === "block-seq" ? resolveBlockSeq(CN2, ctx, token, onError, tag) : resolveFlowCollection(CN2, ctx, token, onError, tag);
  const Coll = coll.constructor;
  if (tagName === "!" || tagName === Coll.tagName) {
    coll.tag = Coll.tagName;
    return coll;
  }
  if (tagName)
    coll.tag = tagName;
  return coll;
}
function composeCollection(CN2, ctx, token, props, onError) {
  const tagToken = props.tag;
  const tagName = !tagToken ? null : ctx.directives.tagName(tagToken.source, (msg) => onError(tagToken, "TAG_RESOLVE_FAILED", msg));
  if (token.type === "block-seq") {
    const { anchor, newlineAfterProp: nl } = props;
    const lastProp = anchor && tagToken ? anchor.offset > tagToken.offset ? anchor : tagToken : anchor ?? tagToken;
    if (lastProp && (!nl || nl.offset < lastProp.offset)) {
      const message = "Missing newline after block sequence props";
      onError(lastProp, "MISSING_CHAR", message);
    }
  }
  const expType = token.type === "block-map" ? "map" : token.type === "block-seq" ? "seq" : token.start.source === "{" ? "map" : "seq";
  if (!tagToken || !tagName || tagName === "!" || tagName === YAMLMap.tagName && expType === "map" || tagName === YAMLSeq.tagName && expType === "seq") {
    return resolveCollection(CN2, ctx, token, onError, tagName);
  }
  let tag = ctx.schema.tags.find((t) => t.tag === tagName && t.collection === expType);
  if (!tag) {
    const kt = ctx.schema.knownTags[tagName];
    if (kt?.collection === expType) {
      ctx.schema.tags.push(Object.assign({}, kt, { default: false }));
      tag = kt;
    } else {
      if (kt) {
        onError(tagToken, "BAD_COLLECTION_TYPE", `${kt.tag} used for ${expType} collection, but expects ${kt.collection ?? "scalar"}`, true);
      } else {
        onError(tagToken, "TAG_RESOLVE_FAILED", `Unresolved tag: ${tagName}`, true);
      }
      return resolveCollection(CN2, ctx, token, onError, tagName);
    }
  }
  const coll = resolveCollection(CN2, ctx, token, onError, tagName, tag);
  const res = tag.resolve?.(coll, (msg) => onError(tagToken, "TAG_RESOLVE_FAILED", msg), ctx.options) ?? coll;
  const node = isNode(res) ? res : new Scalar(res);
  node.range = coll.range;
  node.tag = tagName;
  if (tag?.format)
    node.format = tag.format;
  return node;
}

// node_modules/yaml/browser/dist/compose/resolve-block-scalar.js
function resolveBlockScalar(ctx, scalar, onError) {
  const start = scalar.offset;
  const header = parseBlockScalarHeader(scalar, ctx.options.strict, onError);
  if (!header)
    return { value: "", type: null, comment: "", range: [start, start, start] };
  const type = header.mode === ">" ? Scalar.BLOCK_FOLDED : Scalar.BLOCK_LITERAL;
  const lines = scalar.source ? splitLines(scalar.source) : [];
  let chompStart = lines.length;
  for (let i = lines.length - 1; i >= 0; --i) {
    const content = lines[i][1];
    if (content === "" || content === "\r")
      chompStart = i;
    else
      break;
  }
  if (chompStart === 0) {
    const value2 = header.chomp === "+" && lines.length > 0 ? "\n".repeat(Math.max(1, lines.length - 1)) : "";
    let end2 = start + header.length;
    if (scalar.source)
      end2 += scalar.source.length;
    return { value: value2, type, comment: header.comment, range: [start, end2, end2] };
  }
  let trimIndent = scalar.indent + header.indent;
  let offset = scalar.offset + header.length;
  let contentStart = 0;
  for (let i = 0; i < chompStart; ++i) {
    const [indent, content] = lines[i];
    if (content === "" || content === "\r") {
      if (header.indent === 0 && indent.length > trimIndent)
        trimIndent = indent.length;
    } else {
      if (indent.length < trimIndent) {
        const message = "Block scalars with more-indented leading empty lines must use an explicit indentation indicator";
        onError(offset + indent.length, "MISSING_CHAR", message);
      }
      if (header.indent === 0)
        trimIndent = indent.length;
      contentStart = i;
      if (trimIndent === 0 && !ctx.atRoot) {
        const message = "Block scalar values in collections must be indented";
        onError(offset, "BAD_INDENT", message);
      }
      break;
    }
    offset += indent.length + content.length + 1;
  }
  for (let i = lines.length - 1; i >= chompStart; --i) {
    if (lines[i][0].length > trimIndent)
      chompStart = i + 1;
  }
  let value = "";
  let sep = "";
  let prevMoreIndented = false;
  for (let i = 0; i < contentStart; ++i)
    value += lines[i][0].slice(trimIndent) + "\n";
  for (let i = contentStart; i < chompStart; ++i) {
    let [indent, content] = lines[i];
    offset += indent.length + content.length + 1;
    const crlf = content[content.length - 1] === "\r";
    if (crlf)
      content = content.slice(0, -1);
    if (content && indent.length < trimIndent) {
      const src = header.indent ? "explicit indentation indicator" : "first line";
      const message = `Block scalar lines must not be less indented than their ${src}`;
      onError(offset - content.length - (crlf ? 2 : 1), "BAD_INDENT", message);
      indent = "";
    }
    if (type === Scalar.BLOCK_LITERAL) {
      value += sep + indent.slice(trimIndent) + content;
      sep = "\n";
    } else if (indent.length > trimIndent || content[0] === "	") {
      if (sep === " ")
        sep = "\n";
      else if (!prevMoreIndented && sep === "\n")
        sep = "\n\n";
      value += sep + indent.slice(trimIndent) + content;
      sep = "\n";
      prevMoreIndented = true;
    } else if (content === "") {
      if (sep === "\n")
        value += "\n";
      else
        sep = "\n";
    } else {
      value += sep + content;
      sep = " ";
      prevMoreIndented = false;
    }
  }
  switch (header.chomp) {
    case "-":
      break;
    case "+":
      for (let i = chompStart; i < lines.length; ++i)
        value += "\n" + lines[i][0].slice(trimIndent);
      if (value[value.length - 1] !== "\n")
        value += "\n";
      break;
    default:
      value += "\n";
  }
  const end = start + header.length + scalar.source.length;
  return { value, type, comment: header.comment, range: [start, end, end] };
}
function parseBlockScalarHeader({ offset, props }, strict, onError) {
  if (props[0].type !== "block-scalar-header") {
    onError(props[0], "IMPOSSIBLE", "Block scalar header not found");
    return null;
  }
  const { source } = props[0];
  const mode = source[0];
  let indent = 0;
  let chomp = "";
  let error = -1;
  for (let i = 1; i < source.length; ++i) {
    const ch = source[i];
    if (!chomp && (ch === "-" || ch === "+"))
      chomp = ch;
    else {
      const n = Number(ch);
      if (!indent && n)
        indent = n;
      else if (error === -1)
        error = offset + i;
    }
  }
  if (error !== -1)
    onError(error, "UNEXPECTED_TOKEN", `Block scalar header includes extra characters: ${source}`);
  let hasSpace = false;
  let comment = "";
  let length = source.length;
  for (let i = 1; i < props.length; ++i) {
    const token = props[i];
    switch (token.type) {
      case "space":
        hasSpace = true;
      // fallthrough
      case "newline":
        length += token.source.length;
        break;
      case "comment":
        if (strict && !hasSpace) {
          const message = "Comments must be separated from other tokens by white space characters";
          onError(token, "MISSING_CHAR", message);
        }
        length += token.source.length;
        comment = token.source.substring(1);
        break;
      case "error":
        onError(token, "UNEXPECTED_TOKEN", token.message);
        length += token.source.length;
        break;
      /* istanbul ignore next should not happen */
      default: {
        const message = `Unexpected token in block scalar header: ${token.type}`;
        onError(token, "UNEXPECTED_TOKEN", message);
        const ts = token.source;
        if (ts && typeof ts === "string")
          length += ts.length;
      }
    }
  }
  return { mode, indent, chomp, comment, length };
}
function splitLines(source) {
  const split = source.split(/\n( *)/);
  const first = split[0];
  const m = first.match(/^( *)/);
  const line0 = m?.[1] ? [m[1], first.slice(m[1].length)] : ["", first];
  const lines = [line0];
  for (let i = 1; i < split.length; i += 2)
    lines.push([split[i], split[i + 1]]);
  return lines;
}

// node_modules/yaml/browser/dist/compose/resolve-flow-scalar.js
function resolveFlowScalar(scalar, strict, onError) {
  const { offset, type, source, end } = scalar;
  let _type;
  let value;
  const _onError = (rel, code, msg) => onError(offset + rel, code, msg);
  switch (type) {
    case "scalar":
      _type = Scalar.PLAIN;
      value = plainValue(source, _onError);
      break;
    case "single-quoted-scalar":
      _type = Scalar.QUOTE_SINGLE;
      value = singleQuotedValue(source, _onError);
      break;
    case "double-quoted-scalar":
      _type = Scalar.QUOTE_DOUBLE;
      value = doubleQuotedValue(source, _onError);
      break;
    /* istanbul ignore next should not happen */
    default:
      onError(scalar, "UNEXPECTED_TOKEN", `Expected a flow scalar value, but found: ${type}`);
      return {
        value: "",
        type: null,
        comment: "",
        range: [offset, offset + source.length, offset + source.length]
      };
  }
  const valueEnd = offset + source.length;
  const re = resolveEnd(end, valueEnd, strict, onError);
  return {
    value,
    type: _type,
    comment: re.comment,
    range: [offset, valueEnd, re.offset]
  };
}
function plainValue(source, onError) {
  let badChar = "";
  switch (source[0]) {
    /* istanbul ignore next should not happen */
    case "	":
      badChar = "a tab character";
      break;
    case ",":
      badChar = "flow indicator character ,";
      break;
    case "%":
      badChar = "directive indicator character %";
      break;
    case "|":
    case ">": {
      badChar = `block scalar indicator ${source[0]}`;
      break;
    }
    case "@":
    case "`": {
      badChar = `reserved character ${source[0]}`;
      break;
    }
  }
  if (badChar)
    onError(0, "BAD_SCALAR_START", `Plain value cannot start with ${badChar}`);
  return foldLines(source);
}
function singleQuotedValue(source, onError) {
  if (source[source.length - 1] !== "'" || source.length === 1)
    onError(source.length, "MISSING_CHAR", "Missing closing 'quote");
  return foldLines(source.slice(1, -1)).replace(/''/g, "'");
}
function foldLines(source) {
  let first, line;
  try {
    first = new RegExp("(.*?)(?<![ 	])[ 	]*\r?\n", "sy");
    line = new RegExp("[ 	]*(.*?)(?:(?<![ 	])[ 	]*)?\r?\n", "sy");
  } catch {
    first = /(.*?)[ \t]*\r?\n/sy;
    line = /[ \t]*(.*?)[ \t]*\r?\n/sy;
  }
  let match = first.exec(source);
  if (!match)
    return source;
  let res = match[1];
  let sep = " ";
  let pos = first.lastIndex;
  line.lastIndex = pos;
  while (match = line.exec(source)) {
    if (match[1] === "") {
      if (sep === "\n")
        res += sep;
      else
        sep = "\n";
    } else {
      res += sep + match[1];
      sep = " ";
    }
    pos = line.lastIndex;
  }
  const last = /[ \t]*(.*)/sy;
  last.lastIndex = pos;
  match = last.exec(source);
  return res + sep + (match?.[1] ?? "");
}
function doubleQuotedValue(source, onError) {
  let res = "";
  for (let i = 1; i < source.length - 1; ++i) {
    const ch = source[i];
    if (ch === "\r" && source[i + 1] === "\n")
      continue;
    if (ch === "\n") {
      const { fold, offset } = foldNewline(source, i);
      res += fold;
      i = offset;
    } else if (ch === "\\") {
      let next = source[++i];
      const cc = escapeCodes[next];
      if (cc)
        res += cc;
      else if (next === "\n") {
        next = source[i + 1];
        while (next === " " || next === "	")
          next = source[++i + 1];
      } else if (next === "\r" && source[i + 1] === "\n") {
        next = source[++i + 1];
        while (next === " " || next === "	")
          next = source[++i + 1];
      } else if (next === "x" || next === "u" || next === "U") {
        const length = next === "x" ? 2 : next === "u" ? 4 : 8;
        res += parseCharCode(source, i + 1, length, onError);
        i += length;
      } else {
        const raw = source.substr(i - 1, 2);
        onError(i - 1, "BAD_DQ_ESCAPE", `Invalid escape sequence ${raw}`);
        res += raw;
      }
    } else if (ch === " " || ch === "	") {
      const wsStart = i;
      let next = source[i + 1];
      while (next === " " || next === "	")
        next = source[++i + 1];
      if (next !== "\n" && !(next === "\r" && source[i + 2] === "\n"))
        res += i > wsStart ? source.slice(wsStart, i + 1) : ch;
    } else {
      res += ch;
    }
  }
  if (source[source.length - 1] !== '"' || source.length === 1)
    onError(source.length, "MISSING_CHAR", 'Missing closing "quote');
  return res;
}
function foldNewline(source, offset) {
  let fold = "";
  let ch = source[offset + 1];
  while (ch === " " || ch === "	" || ch === "\n" || ch === "\r") {
    if (ch === "\r" && source[offset + 2] !== "\n")
      break;
    if (ch === "\n")
      fold += "\n";
    offset += 1;
    ch = source[offset + 1];
  }
  if (!fold)
    fold = " ";
  return { fold, offset };
}
var escapeCodes = {
  "0": "\0",
  // null character
  a: "\x07",
  // bell character
  b: "\b",
  // backspace
  e: "\x1B",
  // escape character
  f: "\f",
  // form feed
  n: "\n",
  // line feed
  r: "\r",
  // carriage return
  t: "	",
  // horizontal tab
  v: "\v",
  // vertical tab
  N: "\x85",
  // Unicode next line
  _: "\xA0",
  // Unicode non-breaking space
  L: "\u2028",
  // Unicode line separator
  P: "\u2029",
  // Unicode paragraph separator
  " ": " ",
  '"': '"',
  "/": "/",
  "\\": "\\",
  "	": "	"
};
function parseCharCode(source, offset, length, onError) {
  const cc = source.substr(offset, length);
  const ok = cc.length === length && /^[0-9a-fA-F]+$/.test(cc);
  const code = ok ? parseInt(cc, 16) : NaN;
  try {
    return String.fromCodePoint(code);
  } catch {
    const raw = source.substr(offset - 2, length + 2);
    onError(offset - 2, "BAD_DQ_ESCAPE", `Invalid escape sequence ${raw}`);
    return raw;
  }
}

// node_modules/yaml/browser/dist/compose/compose-scalar.js
function composeScalar(ctx, token, tagToken, onError) {
  const { value, type, comment, range } = token.type === "block-scalar" ? resolveBlockScalar(ctx, token, onError) : resolveFlowScalar(token, ctx.options.strict, onError);
  const tagName = tagToken ? ctx.directives.tagName(tagToken.source, (msg) => onError(tagToken, "TAG_RESOLVE_FAILED", msg)) : null;
  let tag;
  if (ctx.options.stringKeys && ctx.atKey) {
    tag = ctx.schema[SCALAR];
  } else if (tagName)
    tag = findScalarTagByName(ctx.schema, value, tagName, tagToken, onError);
  else if (token.type === "scalar")
    tag = findScalarTagByTest(ctx, value, token, onError);
  else
    tag = ctx.schema[SCALAR];
  let scalar;
  try {
    const res = tag.resolve(value, (msg) => onError(tagToken ?? token, "TAG_RESOLVE_FAILED", msg), ctx.options);
    scalar = isScalar(res) ? res : new Scalar(res);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    onError(tagToken ?? token, "TAG_RESOLVE_FAILED", msg);
    scalar = new Scalar(value);
  }
  scalar.range = range;
  scalar.source = value;
  if (type)
    scalar.type = type;
  if (tagName)
    scalar.tag = tagName;
  if (tag.format)
    scalar.format = tag.format;
  if (comment)
    scalar.comment = comment;
  return scalar;
}
function findScalarTagByName(schema4, value, tagName, tagToken, onError) {
  if (tagName === "!")
    return schema4[SCALAR];
  const matchWithTest = [];
  for (const tag of schema4.tags) {
    if (!tag.collection && tag.tag === tagName) {
      if (tag.default && tag.test)
        matchWithTest.push(tag);
      else
        return tag;
    }
  }
  for (const tag of matchWithTest)
    if (tag.test?.test(value))
      return tag;
  const kt = schema4.knownTags[tagName];
  if (kt && !kt.collection) {
    schema4.tags.push(Object.assign({}, kt, { default: false, test: void 0 }));
    return kt;
  }
  onError(tagToken, "TAG_RESOLVE_FAILED", `Unresolved tag: ${tagName}`, tagName !== "tag:yaml.org,2002:str");
  return schema4[SCALAR];
}
function findScalarTagByTest({ atKey, directives, schema: schema4 }, value, token, onError) {
  const tag = schema4.tags.find((tag2) => (tag2.default === true || atKey && tag2.default === "key") && tag2.test?.test(value)) || schema4[SCALAR];
  if (schema4.compat) {
    const compat = schema4.compat.find((tag2) => tag2.default && tag2.test?.test(value)) ?? schema4[SCALAR];
    if (tag.tag !== compat.tag) {
      const ts = directives.tagString(tag.tag);
      const cs = directives.tagString(compat.tag);
      const msg = `Value may be parsed as either ${ts} or ${cs}`;
      onError(token, "TAG_RESOLVE_FAILED", msg, true);
    }
  }
  return tag;
}

// node_modules/yaml/browser/dist/compose/util-empty-scalar-position.js
function emptyScalarPosition(offset, before, pos) {
  if (before) {
    pos ?? (pos = before.length);
    for (let i = pos - 1; i >= 0; --i) {
      let st = before[i];
      switch (st.type) {
        case "space":
        case "comment":
        case "newline":
          offset -= st.source.length;
          continue;
      }
      st = before[++i];
      while (st?.type === "space") {
        offset += st.source.length;
        st = before[++i];
      }
      break;
    }
  }
  return offset;
}

// node_modules/yaml/browser/dist/compose/compose-node.js
var CN = { composeNode, composeEmptyNode };
function composeNode(ctx, token, props, onError) {
  const atKey = ctx.atKey;
  const { spaceBefore, comment, anchor, tag } = props;
  let node;
  let isSrcToken = true;
  switch (token.type) {
    case "alias":
      node = composeAlias(ctx, token, onError);
      if (anchor || tag)
        onError(token, "ALIAS_PROPS", "An alias node must not specify any properties");
      break;
    case "scalar":
    case "single-quoted-scalar":
    case "double-quoted-scalar":
    case "block-scalar":
      node = composeScalar(ctx, token, tag, onError);
      if (anchor)
        node.anchor = anchor.source.substring(1);
      break;
    case "block-map":
    case "block-seq":
    case "flow-collection":
      try {
        node = composeCollection(CN, ctx, token, props, onError);
        if (anchor)
          node.anchor = anchor.source.substring(1);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        onError(token, "RESOURCE_EXHAUSTION", message);
      }
      break;
    default: {
      const message = token.type === "error" ? token.message : `Unsupported token (type: ${token.type})`;
      onError(token, "UNEXPECTED_TOKEN", message);
      isSrcToken = false;
    }
  }
  node ?? (node = composeEmptyNode(ctx, token.offset, void 0, null, props, onError));
  if (anchor && node.anchor === "")
    onError(anchor, "BAD_ALIAS", "Anchor cannot be an empty string");
  if (atKey && ctx.options.stringKeys && (!isScalar(node) || typeof node.value !== "string" || node.tag && node.tag !== "tag:yaml.org,2002:str")) {
    const msg = "With stringKeys, all keys must be strings";
    onError(tag ?? token, "NON_STRING_KEY", msg);
  }
  if (spaceBefore)
    node.spaceBefore = true;
  if (comment) {
    if (token.type === "scalar" && token.source === "")
      node.comment = comment;
    else
      node.commentBefore = comment;
  }
  if (ctx.options.keepSourceTokens && isSrcToken)
    node.srcToken = token;
  return node;
}
function composeEmptyNode(ctx, offset, before, pos, { spaceBefore, comment, anchor, tag, end }, onError) {
  const token = {
    type: "scalar",
    offset: emptyScalarPosition(offset, before, pos),
    indent: -1,
    source: ""
  };
  const node = composeScalar(ctx, token, tag, onError);
  if (anchor) {
    node.anchor = anchor.source.substring(1);
    if (node.anchor === "")
      onError(anchor, "BAD_ALIAS", "Anchor cannot be an empty string");
  }
  if (spaceBefore)
    node.spaceBefore = true;
  if (comment) {
    node.comment = comment;
    node.range[2] = end;
  }
  return node;
}
function composeAlias({ options }, { offset, source, end }, onError) {
  const alias = new Alias(source.substring(1));
  if (alias.source === "")
    onError(offset, "BAD_ALIAS", "Alias cannot be an empty string");
  if (alias.source.endsWith(":"))
    onError(offset + source.length - 1, "BAD_ALIAS", "Alias ending in : is ambiguous", true);
  const valueEnd = offset + source.length;
  const re = resolveEnd(end, valueEnd, options.strict, onError);
  alias.range = [offset, valueEnd, re.offset];
  if (re.comment)
    alias.comment = re.comment;
  return alias;
}

// node_modules/yaml/browser/dist/compose/compose-doc.js
function composeDoc(options, directives, { offset, start, value, end }, onError) {
  const opts = Object.assign({ _directives: directives }, options);
  const doc = new Document(void 0, opts);
  const ctx = {
    atKey: false,
    atRoot: true,
    directives: doc.directives,
    options: doc.options,
    schema: doc.schema
  };
  const props = resolveProps(start, {
    indicator: "doc-start",
    next: value ?? end?.[0],
    offset,
    onError,
    parentIndent: 0,
    startOnNewline: true
  });
  if (props.found) {
    doc.directives.docStart = true;
    if (value && (value.type === "block-map" || value.type === "block-seq") && !props.hasNewline)
      onError(props.end, "MISSING_CHAR", "Block collection cannot start on same line with directives-end marker");
  }
  doc.contents = value ? composeNode(ctx, value, props, onError) : composeEmptyNode(ctx, props.end, start, null, props, onError);
  const contentEnd = doc.contents.range[2];
  const re = resolveEnd(end, contentEnd, false, onError);
  if (re.comment)
    doc.comment = re.comment;
  doc.range = [offset, contentEnd, re.offset];
  return doc;
}

// node_modules/yaml/browser/dist/compose/composer.js
function getErrorPos(src) {
  if (typeof src === "number")
    return [src, src + 1];
  if (Array.isArray(src))
    return src.length === 2 ? src : [src[0], src[1]];
  const { offset, source } = src;
  return [offset, offset + (typeof source === "string" ? source.length : 1)];
}
function parsePrelude(prelude) {
  let comment = "";
  let atComment = false;
  let afterEmptyLine = false;
  for (let i = 0; i < prelude.length; ++i) {
    const source = prelude[i];
    switch (source[0]) {
      case "#":
        comment += (comment === "" ? "" : afterEmptyLine ? "\n\n" : "\n") + (source.substring(1) || " ");
        atComment = true;
        afterEmptyLine = false;
        break;
      case "%":
        if (prelude[i + 1]?.[0] !== "#")
          i += 1;
        atComment = false;
        break;
      default:
        if (!atComment)
          afterEmptyLine = true;
        atComment = false;
    }
  }
  return { comment, afterEmptyLine };
}
var Composer = class {
  constructor(options = {}) {
    this.doc = null;
    this.atDirectives = false;
    this.prelude = [];
    this.errors = [];
    this.warnings = [];
    this.onError = (source, code, message, warning) => {
      const pos = getErrorPos(source);
      if (warning)
        this.warnings.push(new YAMLWarning(pos, code, message));
      else
        this.errors.push(new YAMLParseError(pos, code, message));
    };
    this.directives = new Directives({ version: options.version || "1.2" });
    this.options = options;
  }
  decorate(doc, afterDoc) {
    const { comment, afterEmptyLine } = parsePrelude(this.prelude);
    if (comment) {
      const dc = doc.contents;
      if (afterDoc) {
        doc.comment = doc.comment ? `${doc.comment}
${comment}` : comment;
      } else if (afterEmptyLine || doc.directives.docStart || !dc) {
        doc.commentBefore = comment;
      } else if (isCollection(dc) && !dc.flow && dc.items.length > 0) {
        let it = dc.items[0];
        if (isPair(it))
          it = it.key;
        const cb = it.commentBefore;
        it.commentBefore = cb ? `${comment}
${cb}` : comment;
      } else {
        const cb = dc.commentBefore;
        dc.commentBefore = cb ? `${comment}
${cb}` : comment;
      }
    }
    if (afterDoc) {
      for (let i = 0; i < this.errors.length; ++i)
        doc.errors.push(this.errors[i]);
      for (let i = 0; i < this.warnings.length; ++i)
        doc.warnings.push(this.warnings[i]);
    } else {
      doc.errors = this.errors;
      doc.warnings = this.warnings;
    }
    this.prelude = [];
    this.errors = [];
    this.warnings = [];
  }
  /**
   * Current stream status information.
   *
   * Mostly useful at the end of input for an empty stream.
   */
  streamInfo() {
    return {
      comment: parsePrelude(this.prelude).comment,
      directives: this.directives,
      errors: this.errors,
      warnings: this.warnings
    };
  }
  /**
   * Compose tokens into documents.
   *
   * @param forceDoc - If the stream contains no document, still emit a final document including any comments and directives that would be applied to a subsequent document.
   * @param endOffset - Should be set if `forceDoc` is also set, to set the document range end and to indicate errors correctly.
   */
  *compose(tokens, forceDoc = false, endOffset = -1) {
    for (const token of tokens)
      yield* this.next(token);
    yield* this.end(forceDoc, endOffset);
  }
  /** Advance the composer by one CST token. */
  *next(token) {
    switch (token.type) {
      case "directive":
        this.directives.add(token.source, (offset, message, warning) => {
          const pos = getErrorPos(token);
          pos[0] += offset;
          this.onError(pos, "BAD_DIRECTIVE", message, warning);
        });
        this.prelude.push(token.source);
        this.atDirectives = true;
        break;
      case "document": {
        const doc = composeDoc(this.options, this.directives, token, this.onError);
        if (this.atDirectives && !doc.directives.docStart)
          this.onError(token, "MISSING_CHAR", "Missing directives-end/doc-start indicator line");
        this.decorate(doc, false);
        if (this.doc)
          yield this.doc;
        this.doc = doc;
        this.atDirectives = false;
        break;
      }
      case "byte-order-mark":
      case "space":
        break;
      case "comment":
      case "newline":
        this.prelude.push(token.source);
        break;
      case "error": {
        const msg = token.source ? `${token.message}: ${JSON.stringify(token.source)}` : token.message;
        const error = new YAMLParseError(getErrorPos(token), "UNEXPECTED_TOKEN", msg);
        if (this.atDirectives || !this.doc)
          this.errors.push(error);
        else
          this.doc.errors.push(error);
        break;
      }
      case "doc-end": {
        if (!this.doc) {
          const msg = "Unexpected doc-end without preceding document";
          this.errors.push(new YAMLParseError(getErrorPos(token), "UNEXPECTED_TOKEN", msg));
          break;
        }
        this.doc.directives.docEnd = true;
        const end = resolveEnd(token.end, token.offset + token.source.length, this.doc.options.strict, this.onError);
        this.decorate(this.doc, true);
        if (end.comment) {
          const dc = this.doc.comment;
          this.doc.comment = dc ? `${dc}
${end.comment}` : end.comment;
        }
        this.doc.range[2] = end.offset;
        break;
      }
      default:
        this.errors.push(new YAMLParseError(getErrorPos(token), "UNEXPECTED_TOKEN", `Unsupported token ${token.type}`));
    }
  }
  /**
   * Call at end of input to yield any remaining document.
   *
   * @param forceDoc - If the stream contains no document, still emit a final document including any comments and directives that would be applied to a subsequent document.
   * @param endOffset - Should be set if `forceDoc` is also set, to set the document range end and to indicate errors correctly.
   */
  *end(forceDoc = false, endOffset = -1) {
    if (this.doc) {
      this.decorate(this.doc, true);
      yield this.doc;
      this.doc = null;
    } else if (forceDoc) {
      const opts = Object.assign({ _directives: this.directives }, this.options);
      const doc = new Document(void 0, opts);
      if (this.atDirectives)
        this.onError(endOffset, "MISSING_CHAR", "Missing directives-end indicator line");
      doc.range = [0, endOffset, endOffset];
      this.decorate(doc, false);
      yield doc;
    }
  }
};

// node_modules/yaml/browser/dist/parse/cst.js
var cst_exports = {};
__export(cst_exports, {
  BOM: () => BOM,
  DOCUMENT: () => DOCUMENT,
  FLOW_END: () => FLOW_END,
  SCALAR: () => SCALAR2,
  createScalarToken: () => createScalarToken,
  isCollection: () => isCollection2,
  isScalar: () => isScalar2,
  prettyToken: () => prettyToken,
  resolveAsScalar: () => resolveAsScalar,
  setScalarValue: () => setScalarValue,
  stringify: () => stringify2,
  tokenType: () => tokenType,
  visit: () => visit2
});

// node_modules/yaml/browser/dist/parse/cst-scalar.js
function resolveAsScalar(token, strict = true, onError) {
  if (token) {
    const _onError = (pos, code, message) => {
      const offset = typeof pos === "number" ? pos : Array.isArray(pos) ? pos[0] : pos.offset;
      if (onError)
        onError(offset, code, message);
      else
        throw new YAMLParseError([offset, offset + 1], code, message);
    };
    switch (token.type) {
      case "scalar":
      case "single-quoted-scalar":
      case "double-quoted-scalar":
        return resolveFlowScalar(token, strict, _onError);
      case "block-scalar":
        return resolveBlockScalar({ options: { strict } }, token, _onError);
    }
  }
  return null;
}
function createScalarToken(value, context) {
  const { implicitKey = false, indent, inFlow = false, offset = -1, type = "PLAIN" } = context;
  const source = stringifyString({ type, value }, {
    implicitKey,
    indent: indent > 0 ? " ".repeat(indent) : "",
    inFlow,
    options: { blockQuote: true, lineWidth: -1 }
  });
  const end = context.end ?? [
    { type: "newline", offset: -1, indent, source: "\n" }
  ];
  switch (source[0]) {
    case "|":
    case ">": {
      const he = source.indexOf("\n");
      const head = source.substring(0, he);
      const body = source.substring(he + 1) + "\n";
      const props = [
        { type: "block-scalar-header", offset, indent, source: head }
      ];
      if (!addEndtoBlockProps(props, end))
        props.push({ type: "newline", offset: -1, indent, source: "\n" });
      return { type: "block-scalar", offset, indent, props, source: body };
    }
    case '"':
      return { type: "double-quoted-scalar", offset, indent, source, end };
    case "'":
      return { type: "single-quoted-scalar", offset, indent, source, end };
    default:
      return { type: "scalar", offset, indent, source, end };
  }
}
function setScalarValue(token, value, context = {}) {
  let { afterKey = false, implicitKey = false, inFlow = false, type } = context;
  let indent = "indent" in token ? token.indent : null;
  if (afterKey && typeof indent === "number")
    indent += 2;
  if (!type)
    switch (token.type) {
      case "single-quoted-scalar":
        type = "QUOTE_SINGLE";
        break;
      case "double-quoted-scalar":
        type = "QUOTE_DOUBLE";
        break;
      case "block-scalar": {
        const header = token.props[0];
        if (header.type !== "block-scalar-header")
          throw new Error("Invalid block scalar header");
        type = header.source[0] === ">" ? "BLOCK_FOLDED" : "BLOCK_LITERAL";
        break;
      }
      default:
        type = "PLAIN";
    }
  const source = stringifyString({ type, value }, {
    implicitKey: implicitKey || indent === null,
    indent: indent !== null && indent > 0 ? " ".repeat(indent) : "",
    inFlow,
    options: { blockQuote: true, lineWidth: -1 }
  });
  switch (source[0]) {
    case "|":
    case ">":
      setBlockScalarValue(token, source);
      break;
    case '"':
      setFlowScalarValue(token, source, "double-quoted-scalar");
      break;
    case "'":
      setFlowScalarValue(token, source, "single-quoted-scalar");
      break;
    default:
      setFlowScalarValue(token, source, "scalar");
  }
}
function setBlockScalarValue(token, source) {
  const he = source.indexOf("\n");
  const head = source.substring(0, he);
  const body = source.substring(he + 1) + "\n";
  if (token.type === "block-scalar") {
    const header = token.props[0];
    if (header.type !== "block-scalar-header")
      throw new Error("Invalid block scalar header");
    header.source = head;
    token.source = body;
  } else {
    const { offset } = token;
    const indent = "indent" in token ? token.indent : -1;
    const props = [
      { type: "block-scalar-header", offset, indent, source: head }
    ];
    if (!addEndtoBlockProps(props, "end" in token ? token.end : void 0))
      props.push({ type: "newline", offset: -1, indent, source: "\n" });
    for (const key of Object.keys(token))
      if (key !== "type" && key !== "offset")
        delete token[key];
    Object.assign(token, { type: "block-scalar", indent, props, source: body });
  }
}
function addEndtoBlockProps(props, end) {
  if (end)
    for (const st of end)
      switch (st.type) {
        case "space":
        case "comment":
          props.push(st);
          break;
        case "newline":
          props.push(st);
          return true;
      }
  return false;
}
function setFlowScalarValue(token, source, type) {
  switch (token.type) {
    case "scalar":
    case "double-quoted-scalar":
    case "single-quoted-scalar":
      token.type = type;
      token.source = source;
      break;
    case "block-scalar": {
      const end = token.props.slice(1);
      let oa = source.length;
      if (token.props[0].type === "block-scalar-header")
        oa -= token.props[0].source.length;
      for (const tok of end)
        tok.offset += oa;
      delete token.props;
      Object.assign(token, { type, source, end });
      break;
    }
    case "block-map":
    case "block-seq": {
      const offset = token.offset + source.length;
      const nl = { type: "newline", offset, indent: token.indent, source: "\n" };
      delete token.items;
      Object.assign(token, { type, source, end: [nl] });
      break;
    }
    default: {
      const indent = "indent" in token ? token.indent : -1;
      const end = "end" in token && Array.isArray(token.end) ? token.end.filter((st) => st.type === "space" || st.type === "comment" || st.type === "newline") : [];
      for (const key of Object.keys(token))
        if (key !== "type" && key !== "offset")
          delete token[key];
      Object.assign(token, { type, indent, source, end });
    }
  }
}

// node_modules/yaml/browser/dist/parse/cst-stringify.js
var stringify2 = (cst) => "type" in cst ? stringifyToken(cst) : stringifyItem(cst);
function stringifyToken(token) {
  switch (token.type) {
    case "block-scalar": {
      let res = "";
      for (const tok of token.props)
        res += stringifyToken(tok);
      return res + token.source;
    }
    case "block-map":
    case "block-seq": {
      let res = "";
      for (const item of token.items)
        res += stringifyItem(item);
      return res;
    }
    case "flow-collection": {
      let res = token.start.source;
      for (const item of token.items)
        res += stringifyItem(item);
      for (const st of token.end)
        res += st.source;
      return res;
    }
    case "document": {
      let res = stringifyItem(token);
      if (token.end)
        for (const st of token.end)
          res += st.source;
      return res;
    }
    default: {
      let res = token.source;
      if ("end" in token && token.end)
        for (const st of token.end)
          res += st.source;
      return res;
    }
  }
}
function stringifyItem({ start, key, sep, value }) {
  let res = "";
  for (const st of start)
    res += st.source;
  if (key)
    res += stringifyToken(key);
  if (sep)
    for (const st of sep)
      res += st.source;
  if (value)
    res += stringifyToken(value);
  return res;
}

// node_modules/yaml/browser/dist/parse/cst-visit.js
var BREAK2 = Symbol("break visit");
var SKIP2 = Symbol("skip children");
var REMOVE2 = Symbol("remove item");
function visit2(cst, visitor) {
  if ("type" in cst && cst.type === "document")
    cst = { start: cst.start, value: cst.value };
  _visit(Object.freeze([]), cst, visitor);
}
visit2.BREAK = BREAK2;
visit2.SKIP = SKIP2;
visit2.REMOVE = REMOVE2;
visit2.itemAtPath = (cst, path) => {
  let item = cst;
  for (const [field, index] of path) {
    const tok = item?.[field];
    if (tok && "items" in tok) {
      item = tok.items[index];
    } else
      return void 0;
  }
  return item;
};
visit2.parentCollection = (cst, path) => {
  const parent = visit2.itemAtPath(cst, path.slice(0, -1));
  const field = path[path.length - 1][0];
  const coll = parent?.[field];
  if (coll && "items" in coll)
    return coll;
  throw new Error("Parent collection not found");
};
function _visit(path, item, visitor) {
  let ctrl = visitor(item, path);
  if (typeof ctrl === "symbol")
    return ctrl;
  for (const field of ["key", "value"]) {
    const token = item[field];
    if (token && "items" in token) {
      for (let i = 0; i < token.items.length; ++i) {
        const ci = _visit(Object.freeze(path.concat([[field, i]])), token.items[i], visitor);
        if (typeof ci === "number")
          i = ci - 1;
        else if (ci === BREAK2)
          return BREAK2;
        else if (ci === REMOVE2) {
          token.items.splice(i, 1);
          i -= 1;
        }
      }
      if (typeof ctrl === "function" && field === "key")
        ctrl = ctrl(item, path);
    }
  }
  return typeof ctrl === "function" ? ctrl(item, path) : ctrl;
}

// node_modules/yaml/browser/dist/parse/cst.js
var BOM = "\uFEFF";
var DOCUMENT = "";
var FLOW_END = "";
var SCALAR2 = "";
var isCollection2 = (token) => !!token && "items" in token;
var isScalar2 = (token) => !!token && (token.type === "scalar" || token.type === "single-quoted-scalar" || token.type === "double-quoted-scalar" || token.type === "block-scalar");
function prettyToken(token) {
  switch (token) {
    case BOM:
      return "<BOM>";
    case DOCUMENT:
      return "<DOC>";
    case FLOW_END:
      return "<FLOW_END>";
    case SCALAR2:
      return "<SCALAR>";
    default:
      return JSON.stringify(token);
  }
}
function tokenType(source) {
  switch (source) {
    case BOM:
      return "byte-order-mark";
    case DOCUMENT:
      return "doc-mode";
    case FLOW_END:
      return "flow-error-end";
    case SCALAR2:
      return "scalar";
    case "---":
      return "doc-start";
    case "...":
      return "doc-end";
    case "":
    case "\n":
    case "\r\n":
      return "newline";
    case "-":
      return "seq-item-ind";
    case "?":
      return "explicit-key-ind";
    case ":":
      return "map-value-ind";
    case "{":
      return "flow-map-start";
    case "}":
      return "flow-map-end";
    case "[":
      return "flow-seq-start";
    case "]":
      return "flow-seq-end";
    case ",":
      return "comma";
  }
  switch (source[0]) {
    case " ":
    case "	":
      return "space";
    case "#":
      return "comment";
    case "%":
      return "directive-line";
    case "*":
      return "alias";
    case "&":
      return "anchor";
    case "!":
      return "tag";
    case "'":
      return "single-quoted-scalar";
    case '"':
      return "double-quoted-scalar";
    case "|":
    case ">":
      return "block-scalar-header";
  }
  return null;
}

// node_modules/yaml/browser/dist/parse/lexer.js
function isEmpty(ch) {
  switch (ch) {
    case void 0:
    case " ":
    case "\n":
    case "\r":
    case "	":
      return true;
    default:
      return false;
  }
}
var hexDigits = new Set("0123456789ABCDEFabcdef");
var tagChars = new Set("0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-#;/?:@&=+$_.!~*'()");
var flowIndicatorChars = new Set(",[]{}");
var invalidAnchorChars = new Set(" ,[]{}\n\r	");
var isNotAnchorChar = (ch) => !ch || invalidAnchorChars.has(ch);
var Lexer = class {
  constructor() {
    this.atEnd = false;
    this.blockScalarIndent = -1;
    this.blockScalarKeep = false;
    this.buffer = "";
    this.flowKey = false;
    this.flowLevel = 0;
    this.indentNext = 0;
    this.indentValue = 0;
    this.lineEndPos = null;
    this.next = null;
    this.pos = 0;
  }
  /**
   * Generate YAML tokens from the `source` string. If `incomplete`,
   * a part of the last line may be left as a buffer for the next call.
   *
   * @returns A generator of lexical tokens
   */
  *lex(source, incomplete = false) {
    if (source) {
      if (typeof source !== "string")
        throw TypeError("source is not a string");
      this.buffer = this.buffer ? this.buffer + source : source;
      this.lineEndPos = null;
    }
    this.atEnd = !incomplete;
    let next = this.next ?? "stream";
    while (next && (incomplete || this.hasChars(1)))
      next = yield* this.parseNext(next);
  }
  atLineEnd() {
    let i = this.pos;
    let ch = this.buffer[i];
    while (ch === " " || ch === "	")
      ch = this.buffer[++i];
    if (!ch || ch === "#" || ch === "\n")
      return true;
    if (ch === "\r")
      return this.buffer[i + 1] === "\n";
    return false;
  }
  charAt(n) {
    return this.buffer[this.pos + n];
  }
  continueScalar(offset) {
    let ch = this.buffer[offset];
    if (this.indentNext > 0) {
      let indent = 0;
      while (ch === " ")
        ch = this.buffer[++indent + offset];
      if (ch === "\r") {
        const next = this.buffer[indent + offset + 1];
        if (next === "\n" || !next && !this.atEnd)
          return offset + indent + 1;
      }
      return ch === "\n" || indent >= this.indentNext || !ch && !this.atEnd ? offset + indent : -1;
    }
    if (ch === "-" || ch === ".") {
      const dt = this.buffer.substr(offset, 3);
      if ((dt === "---" || dt === "...") && isEmpty(this.buffer[offset + 3]))
        return -1;
    }
    return offset;
  }
  getLine() {
    let end = this.lineEndPos;
    if (typeof end !== "number" || end !== -1 && end < this.pos) {
      end = this.buffer.indexOf("\n", this.pos);
      this.lineEndPos = end;
    }
    if (end === -1)
      return this.atEnd ? this.buffer.substring(this.pos) : null;
    if (this.buffer[end - 1] === "\r")
      end -= 1;
    return this.buffer.substring(this.pos, end);
  }
  hasChars(n) {
    return this.pos + n <= this.buffer.length;
  }
  setNext(state) {
    this.buffer = this.buffer.substring(this.pos);
    this.pos = 0;
    this.lineEndPos = null;
    this.next = state;
    return null;
  }
  peek(n) {
    return this.buffer.substr(this.pos, n);
  }
  *parseNext(next) {
    switch (next) {
      case "stream":
        return yield* this.parseStream();
      case "line-start":
        return yield* this.parseLineStart();
      case "block-start":
        return yield* this.parseBlockStart();
      case "doc":
        return yield* this.parseDocument();
      case "flow":
        return yield* this.parseFlowCollection();
      case "quoted-scalar":
        return yield* this.parseQuotedScalar();
      case "block-scalar":
        return yield* this.parseBlockScalar();
      case "plain-scalar":
        return yield* this.parsePlainScalar();
    }
  }
  *parseStream() {
    let line = this.getLine();
    if (line === null)
      return this.setNext("stream");
    if (line[0] === BOM) {
      yield* this.pushCount(1);
      line = line.substring(1);
    }
    if (line[0] === "%") {
      let dirEnd = line.length;
      let cs = line.indexOf("#");
      while (cs !== -1) {
        const ch = line[cs - 1];
        if (ch === " " || ch === "	") {
          dirEnd = cs - 1;
          break;
        } else {
          cs = line.indexOf("#", cs + 1);
        }
      }
      while (true) {
        const ch = line[dirEnd - 1];
        if (ch === " " || ch === "	")
          dirEnd -= 1;
        else
          break;
      }
      const n = (yield* this.pushCount(dirEnd)) + (yield* this.pushSpaces(true));
      yield* this.pushCount(line.length - n);
      this.pushNewline();
      return "stream";
    }
    if (this.atLineEnd()) {
      const sp = yield* this.pushSpaces(true);
      yield* this.pushCount(line.length - sp);
      yield* this.pushNewline();
      return "stream";
    }
    yield DOCUMENT;
    return yield* this.parseLineStart();
  }
  *parseLineStart() {
    const ch = this.charAt(0);
    if (!ch && !this.atEnd)
      return this.setNext("line-start");
    if (ch === "-" || ch === ".") {
      if (!this.atEnd && !this.hasChars(4))
        return this.setNext("line-start");
      const s = this.peek(3);
      if ((s === "---" || s === "...") && isEmpty(this.charAt(3))) {
        yield* this.pushCount(3);
        this.indentValue = 0;
        this.indentNext = 0;
        return s === "---" ? "doc" : "stream";
      }
    }
    this.indentValue = yield* this.pushSpaces(false);
    if (this.indentNext > this.indentValue && !isEmpty(this.charAt(1)))
      this.indentNext = this.indentValue;
    return yield* this.parseBlockStart();
  }
  *parseBlockStart() {
    const [ch0, ch1] = this.peek(2);
    if (!ch1 && !this.atEnd)
      return this.setNext("block-start");
    if ((ch0 === "-" || ch0 === "?" || ch0 === ":") && isEmpty(ch1)) {
      const n = (yield* this.pushCount(1)) + (yield* this.pushSpaces(true));
      this.indentNext = this.indentValue + 1;
      this.indentValue += n;
      return "block-start";
    }
    return "doc";
  }
  *parseDocument() {
    yield* this.pushSpaces(true);
    const line = this.getLine();
    if (line === null)
      return this.setNext("doc");
    let n = yield* this.pushIndicators();
    switch (line[n]) {
      case "#":
        yield* this.pushCount(line.length - n);
      // fallthrough
      case void 0:
        yield* this.pushNewline();
        return yield* this.parseLineStart();
      case "{":
      case "[":
        yield* this.pushCount(1);
        this.flowKey = false;
        this.flowLevel = 1;
        return "flow";
      case "}":
      case "]":
        yield* this.pushCount(1);
        return "doc";
      case "*":
        yield* this.pushUntil(isNotAnchorChar);
        return "doc";
      case '"':
      case "'":
        return yield* this.parseQuotedScalar();
      case "|":
      case ">":
        n += yield* this.parseBlockScalarHeader();
        n += yield* this.pushSpaces(true);
        yield* this.pushCount(line.length - n);
        yield* this.pushNewline();
        return yield* this.parseBlockScalar();
      default:
        return yield* this.parsePlainScalar();
    }
  }
  *parseFlowCollection() {
    let nl, sp;
    let indent = -1;
    do {
      nl = yield* this.pushNewline();
      if (nl > 0) {
        sp = yield* this.pushSpaces(false);
        this.indentValue = indent = sp;
      } else {
        sp = 0;
      }
      sp += yield* this.pushSpaces(true);
    } while (nl + sp > 0);
    const line = this.getLine();
    if (line === null)
      return this.setNext("flow");
    if (indent !== -1 && indent < this.indentNext && line[0] !== "#" || indent === 0 && (line.startsWith("---") || line.startsWith("...")) && isEmpty(line[3])) {
      const atFlowEndMarker = indent === this.indentNext - 1 && this.flowLevel === 1 && (line[0] === "]" || line[0] === "}");
      if (!atFlowEndMarker) {
        this.flowLevel = 0;
        yield FLOW_END;
        return yield* this.parseLineStart();
      }
    }
    let n = 0;
    while (line[n] === ",") {
      n += yield* this.pushCount(1);
      n += yield* this.pushSpaces(true);
      this.flowKey = false;
    }
    n += yield* this.pushIndicators();
    switch (line[n]) {
      case void 0:
        return "flow";
      case "#":
        yield* this.pushCount(line.length - n);
        return "flow";
      case "{":
      case "[":
        yield* this.pushCount(1);
        this.flowKey = false;
        this.flowLevel += 1;
        return "flow";
      case "}":
      case "]":
        yield* this.pushCount(1);
        this.flowKey = true;
        this.flowLevel -= 1;
        return this.flowLevel ? "flow" : "doc";
      case "*":
        yield* this.pushUntil(isNotAnchorChar);
        return "flow";
      case '"':
      case "'":
        this.flowKey = true;
        return yield* this.parseQuotedScalar();
      case ":": {
        const next = this.charAt(1);
        if (this.flowKey || isEmpty(next) || next === ",") {
          this.flowKey = false;
          yield* this.pushCount(1);
          yield* this.pushSpaces(true);
          return "flow";
        }
      }
      // fallthrough
      default:
        this.flowKey = false;
        return yield* this.parsePlainScalar();
    }
  }
  *parseQuotedScalar() {
    const quote = this.charAt(0);
    let end = this.buffer.indexOf(quote, this.pos + 1);
    if (quote === "'") {
      while (end !== -1 && this.buffer[end + 1] === "'")
        end = this.buffer.indexOf("'", end + 2);
    } else {
      while (end !== -1) {
        let n = 0;
        while (this.buffer[end - 1 - n] === "\\")
          n += 1;
        if (n % 2 === 0)
          break;
        end = this.buffer.indexOf('"', end + 1);
      }
    }
    const qb = this.buffer.substring(0, end);
    let nl = qb.indexOf("\n", this.pos);
    if (nl !== -1) {
      while (nl !== -1) {
        const cs = this.continueScalar(nl + 1);
        if (cs === -1)
          break;
        nl = qb.indexOf("\n", cs);
      }
      if (nl !== -1) {
        end = nl - (qb[nl - 1] === "\r" ? 2 : 1);
      }
    }
    if (end === -1) {
      if (!this.atEnd)
        return this.setNext("quoted-scalar");
      end = this.buffer.length;
    }
    yield* this.pushToIndex(end + 1, false);
    return this.flowLevel ? "flow" : "doc";
  }
  *parseBlockScalarHeader() {
    this.blockScalarIndent = -1;
    this.blockScalarKeep = false;
    let i = this.pos;
    while (true) {
      const ch = this.buffer[++i];
      if (ch === "+")
        this.blockScalarKeep = true;
      else if (ch > "0" && ch <= "9")
        this.blockScalarIndent = Number(ch) - 1;
      else if (ch !== "-")
        break;
    }
    return yield* this.pushUntil((ch) => isEmpty(ch) || ch === "#");
  }
  *parseBlockScalar() {
    let nl = this.pos - 1;
    let indent = 0;
    let ch;
    loop: for (let i2 = this.pos; ch = this.buffer[i2]; ++i2) {
      switch (ch) {
        case " ":
          indent += 1;
          break;
        case "\n":
          nl = i2;
          indent = 0;
          break;
        case "\r": {
          const next = this.buffer[i2 + 1];
          if (!next && !this.atEnd)
            return this.setNext("block-scalar");
          if (next === "\n")
            break;
        }
        // fallthrough
        default:
          break loop;
      }
    }
    if (!ch && !this.atEnd)
      return this.setNext("block-scalar");
    if (indent >= this.indentNext) {
      if (this.blockScalarIndent === -1)
        this.indentNext = indent;
      else {
        this.indentNext = this.blockScalarIndent + (this.indentNext === 0 ? 1 : this.indentNext);
      }
      do {
        const cs = this.continueScalar(nl + 1);
        if (cs === -1)
          break;
        nl = this.buffer.indexOf("\n", cs);
      } while (nl !== -1);
      if (nl === -1) {
        if (!this.atEnd)
          return this.setNext("block-scalar");
        nl = this.buffer.length;
      }
    }
    let i = nl + 1;
    ch = this.buffer[i];
    while (ch === " ")
      ch = this.buffer[++i];
    if (ch === "	") {
      while (ch === "	" || ch === " " || ch === "\r" || ch === "\n")
        ch = this.buffer[++i];
      nl = i - 1;
    } else if (!this.blockScalarKeep) {
      do {
        let i2 = nl - 1;
        let ch2 = this.buffer[i2];
        if (ch2 === "\r")
          ch2 = this.buffer[--i2];
        const lastChar = i2;
        while (ch2 === " ")
          ch2 = this.buffer[--i2];
        if (ch2 === "\n" && i2 >= this.pos && i2 + 1 + indent > lastChar)
          nl = i2;
        else
          break;
      } while (true);
    }
    yield SCALAR2;
    yield* this.pushToIndex(nl + 1, true);
    return yield* this.parseLineStart();
  }
  *parsePlainScalar() {
    const inFlow = this.flowLevel > 0;
    let end = this.pos - 1;
    let i = this.pos - 1;
    let ch;
    while (ch = this.buffer[++i]) {
      if (ch === ":") {
        const next = this.buffer[i + 1];
        if (isEmpty(next) || inFlow && flowIndicatorChars.has(next))
          break;
        end = i;
      } else if (isEmpty(ch)) {
        let next = this.buffer[i + 1];
        if (ch === "\r") {
          if (next === "\n") {
            i += 1;
            ch = "\n";
            next = this.buffer[i + 1];
          } else
            end = i;
        }
        if (next === "#" || inFlow && flowIndicatorChars.has(next))
          break;
        if (ch === "\n") {
          const cs = this.continueScalar(i + 1);
          if (cs === -1)
            break;
          i = Math.max(i, cs - 2);
        }
      } else {
        if (inFlow && flowIndicatorChars.has(ch))
          break;
        end = i;
      }
    }
    if (!ch && !this.atEnd)
      return this.setNext("plain-scalar");
    yield SCALAR2;
    yield* this.pushToIndex(end + 1, true);
    return inFlow ? "flow" : "doc";
  }
  *pushCount(n) {
    if (n > 0) {
      yield this.buffer.substr(this.pos, n);
      this.pos += n;
      return n;
    }
    return 0;
  }
  *pushToIndex(i, allowEmpty) {
    const s = this.buffer.slice(this.pos, i);
    if (s) {
      yield s;
      this.pos += s.length;
      return s.length;
    } else if (allowEmpty)
      yield "";
    return 0;
  }
  *pushIndicators() {
    let n = 0;
    loop: while (true) {
      switch (this.charAt(0)) {
        case "!":
          n += yield* this.pushTag();
          n += yield* this.pushSpaces(true);
          continue loop;
        case "&":
          n += yield* this.pushUntil(isNotAnchorChar);
          n += yield* this.pushSpaces(true);
          continue loop;
        case "-":
        // this is an error
        case "?":
        // this is an error outside flow collections
        case ":": {
          const inFlow = this.flowLevel > 0;
          const ch1 = this.charAt(1);
          if (isEmpty(ch1) || inFlow && flowIndicatorChars.has(ch1)) {
            if (!inFlow)
              this.indentNext = this.indentValue + 1;
            else if (this.flowKey)
              this.flowKey = false;
            n += yield* this.pushCount(1);
            n += yield* this.pushSpaces(true);
            continue loop;
          }
        }
      }
      break loop;
    }
    return n;
  }
  *pushTag() {
    if (this.charAt(1) === "<") {
      let i = this.pos + 2;
      let ch = this.buffer[i];
      while (!isEmpty(ch) && ch !== ">")
        ch = this.buffer[++i];
      return yield* this.pushToIndex(ch === ">" ? i + 1 : i, false);
    } else {
      let i = this.pos + 1;
      let ch = this.buffer[i];
      while (ch) {
        if (tagChars.has(ch))
          ch = this.buffer[++i];
        else if (ch === "%" && hexDigits.has(this.buffer[i + 1]) && hexDigits.has(this.buffer[i + 2])) {
          ch = this.buffer[i += 3];
        } else
          break;
      }
      return yield* this.pushToIndex(i, false);
    }
  }
  *pushNewline() {
    const ch = this.buffer[this.pos];
    if (ch === "\n")
      return yield* this.pushCount(1);
    else if (ch === "\r" && this.charAt(1) === "\n")
      return yield* this.pushCount(2);
    else
      return 0;
  }
  *pushSpaces(allowTabs) {
    let i = this.pos - 1;
    let ch;
    do {
      ch = this.buffer[++i];
    } while (ch === " " || allowTabs && ch === "	");
    const n = i - this.pos;
    if (n > 0) {
      yield this.buffer.substr(this.pos, n);
      this.pos = i;
    }
    return n;
  }
  *pushUntil(test) {
    let i = this.pos;
    let ch = this.buffer[i];
    while (!test(ch))
      ch = this.buffer[++i];
    return yield* this.pushToIndex(i, false);
  }
};

// node_modules/yaml/browser/dist/parse/line-counter.js
var LineCounter = class {
  constructor() {
    this.lineStarts = [];
    this.addNewLine = (offset) => this.lineStarts.push(offset);
    this.linePos = (offset) => {
      let low = 0;
      let high = this.lineStarts.length;
      while (low < high) {
        const mid = low + high >> 1;
        if (this.lineStarts[mid] < offset)
          low = mid + 1;
        else
          high = mid;
      }
      if (this.lineStarts[low] === offset)
        return { line: low + 1, col: 1 };
      if (low === 0)
        return { line: 0, col: offset };
      const start = this.lineStarts[low - 1];
      return { line: low, col: offset - start + 1 };
    };
  }
};

// node_modules/yaml/browser/dist/parse/parser.js
function includesToken(list, type) {
  for (let i = 0; i < list.length; ++i)
    if (list[i].type === type)
      return true;
  return false;
}
function findNonEmptyIndex(list) {
  for (let i = 0; i < list.length; ++i) {
    switch (list[i].type) {
      case "space":
      case "comment":
      case "newline":
        break;
      default:
        return i;
    }
  }
  return -1;
}
function isFlowToken(token) {
  switch (token?.type) {
    case "alias":
    case "scalar":
    case "single-quoted-scalar":
    case "double-quoted-scalar":
    case "flow-collection":
      return true;
    default:
      return false;
  }
}
function getPrevProps(parent) {
  switch (parent.type) {
    case "document":
      return parent.start;
    case "block-map": {
      const it = parent.items[parent.items.length - 1];
      return it.sep ?? it.start;
    }
    case "block-seq":
      return parent.items[parent.items.length - 1].start;
    /* istanbul ignore next should not happen */
    default:
      return [];
  }
}
function getFirstKeyStartProps(prev) {
  if (prev.length === 0)
    return [];
  let i = prev.length;
  loop: while (--i >= 0) {
    switch (prev[i].type) {
      case "doc-start":
      case "explicit-key-ind":
      case "map-value-ind":
      case "seq-item-ind":
      case "newline":
        break loop;
    }
  }
  while (prev[++i]?.type === "space") {
  }
  return prev.splice(i, prev.length);
}
function arrayPushArray(target, source) {
  if (source.length < 1e5)
    Array.prototype.push.apply(target, source);
  else
    for (let i = 0; i < source.length; ++i)
      target.push(source[i]);
}
function fixFlowSeqItems(fc) {
  if (fc.start.type === "flow-seq-start") {
    for (const it of fc.items) {
      if (it.sep && !it.value && !includesToken(it.start, "explicit-key-ind") && !includesToken(it.sep, "map-value-ind")) {
        if (it.key)
          it.value = it.key;
        delete it.key;
        if (isFlowToken(it.value)) {
          if (it.value.end)
            arrayPushArray(it.value.end, it.sep);
          else
            it.value.end = it.sep;
        } else
          arrayPushArray(it.start, it.sep);
        delete it.sep;
      }
    }
  }
}
var Parser = class {
  /**
   * @param onNewLine - If defined, called separately with the start position of
   *   each new line (in `parse()`, including the start of input).
   */
  constructor(onNewLine) {
    this.atNewLine = true;
    this.atScalar = false;
    this.indent = 0;
    this.offset = 0;
    this.onKeyLine = false;
    this.stack = [];
    this.source = "";
    this.type = "";
    this.lexer = new Lexer();
    this.onNewLine = onNewLine;
  }
  /**
   * Parse `source` as a YAML stream.
   * If `incomplete`, a part of the last line may be left as a buffer for the next call.
   *
   * Errors are not thrown, but yielded as `{ type: 'error', message }` tokens.
   *
   * @returns A generator of tokens representing each directive, document, and other structure.
   */
  *parse(source, incomplete = false) {
    if (this.onNewLine && this.offset === 0)
      this.onNewLine(0);
    for (const lexeme of this.lexer.lex(source, incomplete))
      yield* this.next(lexeme);
    if (!incomplete)
      yield* this.end();
  }
  /**
   * Advance the parser by the `source` of one lexical token.
   */
  *next(source) {
    this.source = source;
    if (this.atScalar) {
      this.atScalar = false;
      yield* this.step();
      this.offset += source.length;
      return;
    }
    const type = tokenType(source);
    if (!type) {
      const message = `Not a YAML token: ${source}`;
      yield* this.pop({ type: "error", offset: this.offset, message, source });
      this.offset += source.length;
    } else if (type === "scalar") {
      this.atNewLine = false;
      this.atScalar = true;
      this.type = "scalar";
    } else {
      this.type = type;
      yield* this.step();
      switch (type) {
        case "newline":
          this.atNewLine = true;
          this.indent = 0;
          if (this.onNewLine)
            this.onNewLine(this.offset + source.length);
          break;
        case "space":
          if (this.atNewLine && source[0] === " ")
            this.indent += source.length;
          break;
        case "explicit-key-ind":
        case "map-value-ind":
        case "seq-item-ind":
          if (this.atNewLine)
            this.indent += source.length;
          break;
        case "doc-mode":
        case "flow-error-end":
          return;
        default:
          this.atNewLine = false;
      }
      this.offset += source.length;
    }
  }
  /** Call at end of input to push out any remaining constructions */
  *end() {
    while (this.stack.length > 0)
      yield* this.pop();
  }
  get sourceToken() {
    const st = {
      type: this.type,
      offset: this.offset,
      indent: this.indent,
      source: this.source
    };
    return st;
  }
  *step() {
    const top = this.peek(1);
    if (this.type === "doc-end" && top?.type !== "doc-end") {
      while (this.stack.length > 0)
        yield* this.pop();
      this.stack.push({
        type: "doc-end",
        offset: this.offset,
        source: this.source
      });
      return;
    }
    if (!top)
      return yield* this.stream();
    switch (top.type) {
      case "document":
        return yield* this.document(top);
      case "alias":
      case "scalar":
      case "single-quoted-scalar":
      case "double-quoted-scalar":
        return yield* this.scalar(top);
      case "block-scalar":
        return yield* this.blockScalar(top);
      case "block-map":
        return yield* this.blockMap(top);
      case "block-seq":
        return yield* this.blockSequence(top);
      case "flow-collection":
        return yield* this.flowCollection(top);
      case "doc-end":
        return yield* this.documentEnd(top);
    }
    yield* this.pop();
  }
  peek(n) {
    return this.stack[this.stack.length - n];
  }
  *pop(error) {
    const token = error ?? this.stack.pop();
    if (!token) {
      const message = "Tried to pop an empty stack";
      yield { type: "error", offset: this.offset, source: "", message };
    } else if (this.stack.length === 0) {
      yield token;
    } else {
      const top = this.peek(1);
      if (token.type === "block-scalar") {
        token.indent = "indent" in top ? top.indent : 0;
      } else if (token.type === "flow-collection" && top.type === "document") {
        token.indent = 0;
      }
      if (token.type === "flow-collection")
        fixFlowSeqItems(token);
      switch (top.type) {
        case "document":
          top.value = token;
          break;
        case "block-scalar":
          top.props.push(token);
          break;
        case "block-map": {
          const it = top.items[top.items.length - 1];
          if (it.value) {
            top.items.push({ start: [], key: token, sep: [] });
            this.onKeyLine = true;
            return;
          } else if (it.sep) {
            it.value = token;
          } else {
            Object.assign(it, { key: token, sep: [] });
            this.onKeyLine = !it.explicitKey;
            return;
          }
          break;
        }
        case "block-seq": {
          const it = top.items[top.items.length - 1];
          if (it.value)
            top.items.push({ start: [], value: token });
          else
            it.value = token;
          break;
        }
        case "flow-collection": {
          const it = top.items[top.items.length - 1];
          if (!it || it.value)
            top.items.push({ start: [], key: token, sep: [] });
          else if (it.sep)
            it.value = token;
          else
            Object.assign(it, { key: token, sep: [] });
          return;
        }
        /* istanbul ignore next should not happen */
        default:
          yield* this.pop();
          yield* this.pop(token);
      }
      if ((top.type === "document" || top.type === "block-map" || top.type === "block-seq") && (token.type === "block-map" || token.type === "block-seq")) {
        const last = token.items[token.items.length - 1];
        if (last && !last.sep && !last.value && last.start.length > 0 && findNonEmptyIndex(last.start) === -1 && (token.indent === 0 || last.start.every((st) => st.type !== "comment" || st.indent < token.indent))) {
          if (top.type === "document")
            top.end = last.start;
          else
            top.items.push({ start: last.start });
          token.items.splice(-1, 1);
        }
      }
    }
  }
  *stream() {
    switch (this.type) {
      case "directive-line":
        yield { type: "directive", offset: this.offset, source: this.source };
        return;
      case "byte-order-mark":
      case "space":
      case "comment":
      case "newline":
        yield this.sourceToken;
        return;
      case "doc-mode":
      case "doc-start": {
        const doc = {
          type: "document",
          offset: this.offset,
          start: []
        };
        if (this.type === "doc-start")
          doc.start.push(this.sourceToken);
        this.stack.push(doc);
        return;
      }
    }
    yield {
      type: "error",
      offset: this.offset,
      message: `Unexpected ${this.type} token in YAML stream`,
      source: this.source
    };
  }
  *document(doc) {
    if (doc.value)
      return yield* this.lineEnd(doc);
    switch (this.type) {
      case "doc-start": {
        if (findNonEmptyIndex(doc.start) !== -1) {
          yield* this.pop();
          yield* this.step();
        } else
          doc.start.push(this.sourceToken);
        return;
      }
      case "anchor":
      case "tag":
      case "space":
      case "comment":
      case "newline":
        doc.start.push(this.sourceToken);
        return;
    }
    const bv = this.startBlockValue(doc);
    if (bv)
      this.stack.push(bv);
    else {
      yield {
        type: "error",
        offset: this.offset,
        message: `Unexpected ${this.type} token in YAML document`,
        source: this.source
      };
    }
  }
  *scalar(scalar) {
    if (this.type === "map-value-ind") {
      const prev = getPrevProps(this.peek(2));
      const start = getFirstKeyStartProps(prev);
      let sep;
      if (scalar.end) {
        sep = scalar.end;
        sep.push(this.sourceToken);
        delete scalar.end;
      } else
        sep = [this.sourceToken];
      const map2 = {
        type: "block-map",
        offset: scalar.offset,
        indent: scalar.indent,
        items: [{ start, key: scalar, sep }]
      };
      this.onKeyLine = true;
      this.stack[this.stack.length - 1] = map2;
    } else
      yield* this.lineEnd(scalar);
  }
  *blockScalar(scalar) {
    switch (this.type) {
      case "space":
      case "comment":
      case "newline":
        scalar.props.push(this.sourceToken);
        return;
      case "scalar":
        scalar.source = this.source;
        this.atNewLine = true;
        this.indent = 0;
        if (this.onNewLine) {
          let nl = this.source.indexOf("\n") + 1;
          while (nl !== 0) {
            this.onNewLine(this.offset + nl);
            nl = this.source.indexOf("\n", nl) + 1;
          }
        }
        yield* this.pop();
        break;
      /* istanbul ignore next should not happen */
      default:
        yield* this.pop();
        yield* this.step();
    }
  }
  *blockMap(map2) {
    const it = map2.items[map2.items.length - 1];
    switch (this.type) {
      case "newline":
        this.onKeyLine = false;
        if (it.value) {
          const end = "end" in it.value ? it.value.end : void 0;
          const last = Array.isArray(end) ? end[end.length - 1] : void 0;
          if (last?.type === "comment")
            end?.push(this.sourceToken);
          else
            map2.items.push({ start: [this.sourceToken] });
        } else if (it.sep) {
          it.sep.push(this.sourceToken);
        } else {
          it.start.push(this.sourceToken);
        }
        return;
      case "space":
      case "comment":
        if (it.value) {
          map2.items.push({ start: [this.sourceToken] });
        } else if (it.sep) {
          it.sep.push(this.sourceToken);
        } else {
          if (this.atIndentedComment(it.start, map2.indent)) {
            const prev = map2.items[map2.items.length - 2];
            const end = prev?.value?.end;
            if (Array.isArray(end)) {
              arrayPushArray(end, it.start);
              end.push(this.sourceToken);
              map2.items.pop();
              return;
            }
          }
          it.start.push(this.sourceToken);
        }
        return;
    }
    if (this.indent >= map2.indent) {
      const atMapIndent = !this.onKeyLine && this.indent === map2.indent;
      const atNextItem = atMapIndent && (it.sep || it.explicitKey) && this.type !== "seq-item-ind";
      let start = [];
      if (atNextItem && it.sep && !it.value) {
        const nl = [];
        for (let i = 0; i < it.sep.length; ++i) {
          const st = it.sep[i];
          switch (st.type) {
            case "newline":
              nl.push(i);
              break;
            case "space":
              break;
            case "comment":
              if (st.indent > map2.indent)
                nl.length = 0;
              break;
            default:
              nl.length = 0;
          }
        }
        if (nl.length >= 2)
          start = it.sep.splice(nl[1]);
      }
      switch (this.type) {
        case "anchor":
        case "tag":
          if (atNextItem || it.value) {
            start.push(this.sourceToken);
            map2.items.push({ start });
            this.onKeyLine = true;
          } else if (it.sep) {
            it.sep.push(this.sourceToken);
          } else {
            it.start.push(this.sourceToken);
          }
          return;
        case "explicit-key-ind":
          if (!it.sep && !it.explicitKey) {
            it.start.push(this.sourceToken);
            it.explicitKey = true;
          } else if (atNextItem || it.value) {
            start.push(this.sourceToken);
            map2.items.push({ start, explicitKey: true });
          } else {
            this.stack.push({
              type: "block-map",
              offset: this.offset,
              indent: this.indent,
              items: [{ start: [this.sourceToken], explicitKey: true }]
            });
          }
          this.onKeyLine = true;
          return;
        case "map-value-ind":
          if (it.explicitKey) {
            if (!it.sep) {
              if (includesToken(it.start, "newline")) {
                Object.assign(it, { key: null, sep: [this.sourceToken] });
              } else {
                const start2 = getFirstKeyStartProps(it.start);
                this.stack.push({
                  type: "block-map",
                  offset: this.offset,
                  indent: this.indent,
                  items: [{ start: start2, key: null, sep: [this.sourceToken] }]
                });
              }
            } else if (it.value) {
              map2.items.push({ start: [], key: null, sep: [this.sourceToken] });
            } else if (includesToken(it.sep, "map-value-ind")) {
              this.stack.push({
                type: "block-map",
                offset: this.offset,
                indent: this.indent,
                items: [{ start, key: null, sep: [this.sourceToken] }]
              });
            } else if (isFlowToken(it.key) && !includesToken(it.sep, "newline")) {
              const start2 = getFirstKeyStartProps(it.start);
              const key = it.key;
              const sep = it.sep;
              sep.push(this.sourceToken);
              delete it.key;
              delete it.sep;
              this.stack.push({
                type: "block-map",
                offset: this.offset,
                indent: this.indent,
                items: [{ start: start2, key, sep }]
              });
            } else if (start.length > 0) {
              it.sep = it.sep.concat(start, this.sourceToken);
            } else {
              it.sep.push(this.sourceToken);
            }
          } else {
            if (!it.sep) {
              Object.assign(it, { key: null, sep: [this.sourceToken] });
            } else if (it.value || atNextItem) {
              map2.items.push({ start, key: null, sep: [this.sourceToken] });
            } else if (includesToken(it.sep, "map-value-ind")) {
              this.stack.push({
                type: "block-map",
                offset: this.offset,
                indent: this.indent,
                items: [{ start: [], key: null, sep: [this.sourceToken] }]
              });
            } else {
              it.sep.push(this.sourceToken);
            }
          }
          this.onKeyLine = true;
          return;
        case "alias":
        case "scalar":
        case "single-quoted-scalar":
        case "double-quoted-scalar": {
          const fs = this.flowScalar(this.type);
          if (atNextItem || it.value) {
            map2.items.push({ start, key: fs, sep: [] });
            this.onKeyLine = true;
          } else if (it.sep) {
            this.stack.push(fs);
          } else {
            Object.assign(it, { key: fs, sep: [] });
            this.onKeyLine = true;
          }
          return;
        }
        default: {
          const bv = this.startBlockValue(map2);
          if (bv) {
            if (bv.type === "block-seq") {
              if (!it.explicitKey && it.sep && !includesToken(it.sep, "newline")) {
                yield* this.pop({
                  type: "error",
                  offset: this.offset,
                  message: "Unexpected block-seq-ind on same line with key",
                  source: this.source
                });
                return;
              }
            } else if (atMapIndent) {
              map2.items.push({ start });
            }
            this.stack.push(bv);
            return;
          }
        }
      }
    }
    yield* this.pop();
    yield* this.step();
  }
  *blockSequence(seq2) {
    const it = seq2.items[seq2.items.length - 1];
    switch (this.type) {
      case "newline":
        if (it.value) {
          const end = "end" in it.value ? it.value.end : void 0;
          const last = Array.isArray(end) ? end[end.length - 1] : void 0;
          if (last?.type === "comment")
            end?.push(this.sourceToken);
          else
            seq2.items.push({ start: [this.sourceToken] });
        } else
          it.start.push(this.sourceToken);
        return;
      case "space":
      case "comment":
        if (it.value)
          seq2.items.push({ start: [this.sourceToken] });
        else {
          if (this.atIndentedComment(it.start, seq2.indent)) {
            const prev = seq2.items[seq2.items.length - 2];
            const end = prev?.value?.end;
            if (Array.isArray(end)) {
              arrayPushArray(end, it.start);
              end.push(this.sourceToken);
              seq2.items.pop();
              return;
            }
          }
          it.start.push(this.sourceToken);
        }
        return;
      case "anchor":
      case "tag":
        if (it.value || this.indent <= seq2.indent)
          break;
        it.start.push(this.sourceToken);
        return;
      case "seq-item-ind":
        if (this.indent !== seq2.indent)
          break;
        if (it.value || includesToken(it.start, "seq-item-ind"))
          seq2.items.push({ start: [this.sourceToken] });
        else
          it.start.push(this.sourceToken);
        return;
    }
    if (this.indent > seq2.indent) {
      const bv = this.startBlockValue(seq2);
      if (bv) {
        this.stack.push(bv);
        return;
      }
    }
    yield* this.pop();
    yield* this.step();
  }
  *flowCollection(fc) {
    const it = fc.items[fc.items.length - 1];
    if (this.type === "flow-error-end") {
      let top;
      do {
        yield* this.pop();
        top = this.peek(1);
      } while (top?.type === "flow-collection");
    } else if (fc.end.length === 0) {
      switch (this.type) {
        case "comma":
        case "explicit-key-ind":
          if (!it || it.sep)
            fc.items.push({ start: [this.sourceToken] });
          else
            it.start.push(this.sourceToken);
          return;
        case "map-value-ind":
          if (!it || it.value)
            fc.items.push({ start: [], key: null, sep: [this.sourceToken] });
          else if (it.sep)
            it.sep.push(this.sourceToken);
          else
            Object.assign(it, { key: null, sep: [this.sourceToken] });
          return;
        case "space":
        case "comment":
        case "newline":
        case "anchor":
        case "tag":
          if (!it || it.value)
            fc.items.push({ start: [this.sourceToken] });
          else if (it.sep)
            it.sep.push(this.sourceToken);
          else
            it.start.push(this.sourceToken);
          return;
        case "alias":
        case "scalar":
        case "single-quoted-scalar":
        case "double-quoted-scalar": {
          const fs = this.flowScalar(this.type);
          if (!it || it.value)
            fc.items.push({ start: [], key: fs, sep: [] });
          else if (it.sep)
            this.stack.push(fs);
          else
            Object.assign(it, { key: fs, sep: [] });
          return;
        }
        case "flow-map-end":
        case "flow-seq-end":
          fc.end.push(this.sourceToken);
          return;
      }
      const bv = this.startBlockValue(fc);
      if (bv)
        this.stack.push(bv);
      else {
        yield* this.pop();
        yield* this.step();
      }
    } else {
      const parent = this.peek(2);
      if (parent.type === "block-map" && (this.type === "map-value-ind" && parent.indent === fc.indent || this.type === "newline" && !parent.items[parent.items.length - 1].sep)) {
        yield* this.pop();
        yield* this.step();
      } else if (this.type === "map-value-ind" && parent.type !== "flow-collection") {
        const prev = getPrevProps(parent);
        const start = getFirstKeyStartProps(prev);
        fixFlowSeqItems(fc);
        const sep = fc.end.splice(1, fc.end.length);
        sep.push(this.sourceToken);
        const map2 = {
          type: "block-map",
          offset: fc.offset,
          indent: fc.indent,
          items: [{ start, key: fc, sep }]
        };
        this.onKeyLine = true;
        this.stack[this.stack.length - 1] = map2;
      } else {
        yield* this.lineEnd(fc);
      }
    }
  }
  flowScalar(type) {
    if (this.onNewLine) {
      let nl = this.source.indexOf("\n") + 1;
      while (nl !== 0) {
        this.onNewLine(this.offset + nl);
        nl = this.source.indexOf("\n", nl) + 1;
      }
    }
    return {
      type,
      offset: this.offset,
      indent: this.indent,
      source: this.source
    };
  }
  startBlockValue(parent) {
    switch (this.type) {
      case "alias":
      case "scalar":
      case "single-quoted-scalar":
      case "double-quoted-scalar":
        return this.flowScalar(this.type);
      case "block-scalar-header":
        return {
          type: "block-scalar",
          offset: this.offset,
          indent: this.indent,
          props: [this.sourceToken],
          source: ""
        };
      case "flow-map-start":
      case "flow-seq-start":
        return {
          type: "flow-collection",
          offset: this.offset,
          indent: this.indent,
          start: this.sourceToken,
          items: [],
          end: []
        };
      case "seq-item-ind":
        return {
          type: "block-seq",
          offset: this.offset,
          indent: this.indent,
          items: [{ start: [this.sourceToken] }]
        };
      case "explicit-key-ind": {
        this.onKeyLine = true;
        const prev = getPrevProps(parent);
        const start = getFirstKeyStartProps(prev);
        start.push(this.sourceToken);
        return {
          type: "block-map",
          offset: this.offset,
          indent: this.indent,
          items: [{ start, explicitKey: true }]
        };
      }
      case "map-value-ind": {
        this.onKeyLine = true;
        const prev = getPrevProps(parent);
        const start = getFirstKeyStartProps(prev);
        return {
          type: "block-map",
          offset: this.offset,
          indent: this.indent,
          items: [{ start, key: null, sep: [this.sourceToken] }]
        };
      }
    }
    return null;
  }
  atIndentedComment(start, indent) {
    if (this.type !== "comment")
      return false;
    if (this.indent <= indent)
      return false;
    return start.every((st) => st.type === "newline" || st.type === "space");
  }
  *documentEnd(docEnd) {
    if (this.type !== "doc-mode") {
      if (docEnd.end)
        docEnd.end.push(this.sourceToken);
      else
        docEnd.end = [this.sourceToken];
      if (this.type === "newline")
        yield* this.pop();
    }
  }
  *lineEnd(token) {
    switch (this.type) {
      case "comma":
      case "doc-start":
      case "doc-end":
      case "flow-seq-end":
      case "flow-map-end":
      case "map-value-ind":
        yield* this.pop();
        yield* this.step();
        break;
      case "newline":
        this.onKeyLine = false;
      // fallthrough
      case "space":
      case "comment":
      default:
        if (token.end)
          token.end.push(this.sourceToken);
        else
          token.end = [this.sourceToken];
        if (this.type === "newline")
          yield* this.pop();
    }
  }
};

// node_modules/yaml/browser/dist/public-api.js
function parseOptions(options) {
  const prettyErrors = options.prettyErrors !== false;
  const lineCounter = options.lineCounter || prettyErrors && new LineCounter() || null;
  return { lineCounter, prettyErrors };
}
function parseAllDocuments(source, options = {}) {
  const { lineCounter, prettyErrors } = parseOptions(options);
  const parser = new Parser(lineCounter?.addNewLine);
  const composer = new Composer(options);
  const docs = Array.from(composer.compose(parser.parse(source)));
  if (prettyErrors && lineCounter)
    for (const doc of docs) {
      doc.errors.forEach(prettifyError(source, lineCounter));
      doc.warnings.forEach(prettifyError(source, lineCounter));
    }
  if (docs.length > 0)
    return docs;
  return Object.assign([], { empty: true }, composer.streamInfo());
}
function parseDocument(source, options = {}) {
  const { lineCounter, prettyErrors } = parseOptions(options);
  const parser = new Parser(lineCounter?.addNewLine);
  const composer = new Composer(options);
  let doc = null;
  for (const _doc of composer.compose(parser.parse(source), true, source.length)) {
    if (!doc)
      doc = _doc;
    else if (doc.options.logLevel !== "silent") {
      doc.errors.push(new YAMLParseError(_doc.range.slice(0, 2), "MULTIPLE_DOCS", "Source contains multiple documents; please use YAML.parseAllDocuments()"));
      break;
    }
  }
  if (prettyErrors && lineCounter) {
    doc.errors.forEach(prettifyError(source, lineCounter));
    doc.warnings.forEach(prettifyError(source, lineCounter));
  }
  return doc;
}
function parse(src, reviver, options) {
  let _reviver = void 0;
  if (typeof reviver === "function") {
    _reviver = reviver;
  } else if (options === void 0 && reviver && typeof reviver === "object") {
    options = reviver;
  }
  const doc = parseDocument(src, options);
  if (!doc)
    return null;
  doc.warnings.forEach((warning) => warn(doc.options.logLevel, warning));
  if (doc.errors.length > 0) {
    if (doc.options.logLevel !== "silent")
      throw doc.errors[0];
    else
      doc.errors = [];
  }
  return doc.toJS(Object.assign({ reviver: _reviver }, options));
}
function stringify3(value, replacer, options) {
  let _replacer = null;
  if (typeof replacer === "function" || Array.isArray(replacer)) {
    _replacer = replacer;
  } else if (options === void 0 && replacer) {
    options = replacer;
  }
  if (typeof options === "string")
    options = options.length;
  if (typeof options === "number") {
    const indent = Math.round(options);
    options = indent < 1 ? void 0 : indent > 8 ? { indent: 8 } : { indent };
  }
  if (value === void 0) {
    const { keepUndefined } = options ?? replacer ?? {};
    if (!keepUndefined)
      return void 0;
  }
  if (isDocument(value) && !_replacer)
    return value.toString(options);
  return new Document(value, _replacer, options).toString(options);
}

// node_modules/yaml/browser/index.js
var browser_default = dist_exports;

// src/registry.ts
import { mkdir as mkdir2, readFile as readFile2, readdir, stat } from "node:fs/promises";
import { basename, extname, join as join2 } from "node:path";

// src/types.ts
var DEFAULT_READ_TOOLS = ["read", "grep", "find", "ls"];
var SHADOW_TRIGGERS = ["heartbeat", "final_response"];

// src/registry.ts
var ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;
var ShadowRegistry = class {
  directory;
  cache = /* @__PURE__ */ new Map();
  constructor(agentDir) {
    this.directory = join2(agentDir, "shadow-minds");
  }
  async initialize() {
    await mkdir2(this.directory, { recursive: true });
  }
  async load() {
    await this.initialize();
    const names = (await readdir(this.directory)).filter((name) => extname(name).toLowerCase() === ".md").sort();
    const shadows = [];
    const diagnostics = [];
    const seen = /* @__PURE__ */ new Set();
    for (const name of names) {
      const filePath = join2(this.directory, name);
      seen.add(filePath);
      const fileStat = await stat(filePath);
      const cached = this.cache.get(filePath);
      if (cached && cached.mtimeMs === fileStat.mtimeMs) {
        if (cached.shadow) shadows.push(cached.shadow);
        if (cached.error) diagnostics.push({ filePath, message: cached.error });
        continue;
      }
      try {
        const definition = parseShadowMarkdown(
          await readFile2(filePath, "utf8"),
          filePath
        );
        this.cache.set(filePath, {
          mtimeMs: fileStat.mtimeMs,
          shadow: definition
        });
        shadows.push(definition);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.cache.set(filePath, { mtimeMs: fileStat.mtimeMs, error: message });
        diagnostics.push({ filePath, message });
      }
    }
    for (const filePath of [...this.cache.keys()]) {
      if (!seen.has(filePath)) this.cache.delete(filePath);
    }
    const unique = [];
    const ids = /* @__PURE__ */ new Set();
    for (const shadow of shadows) {
      if (ids.has(shadow.id)) {
        diagnostics.push({
          filePath: shadow.filePath,
          message: `duplicate shadow id: ${shadow.id}`
        });
      } else {
        ids.add(shadow.id);
        unique.push(shadow);
      }
    }
    return { shadows: unique, diagnostics };
  }
};
function parseShadowMarkdown(source, filePath) {
  const match = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)([\s\S]*)$/.exec(
    source
  );
  if (!match) throw new Error("missing YAML frontmatter");
  const meta = browser_default.parse(match[1]);
  if (!meta || typeof meta !== "object" || Array.isArray(meta))
    throw new Error("frontmatter must be an object");
  const value = meta;
  const fallbackId = basename(filePath, extname(filePath));
  const id = stringValue(value.id, fallbackId, "id");
  if (!ID_PATTERN.test(id))
    throw new Error("id must match [a-z0-9][a-z0-9_-]*");
  const prompt = match[2].trim();
  if (!prompt) throw new Error("shadow prompt body is empty");
  return {
    id,
    name: stringValue(value.name, id, "name"),
    enabled: booleanValue(value.enabled, true, "enabled"),
    debug: booleanValue(value.debug, false, "debug"),
    activationProbability: probabilityValue(
      value.activation_probability,
      0.3,
      "activation_probability"
    ),
    trigger: triggerArray(value.trigger, ["heartbeat"], "trigger"),
    activeForModels: cleanStringArray(
      value.active_for_models,
      ["*"],
      "active_for_models"
    ),
    runWithModel: optionalString(value.run_with_model, "run_with_model"),
    thinkingLevel: optionalThinking(value.thinking_level),
    timeoutSeconds: optionalPositiveNumber(
      value.timeout_seconds,
      "timeout_seconds"
    ),
    finalResponseRounds: optionalNonNegativeInteger(
      value.final_response_rounds,
      "final_response_rounds"
    ),
    activationTools: cleanStringArray(
      value.activation_tools,
      [],
      "activation_tools"
    ),
    tools: cleanStringArray(value.tools, [], "tools"),
    prompt,
    filePath
  };
}
function stringValue(value, fallback, name) {
  if (value === void 0) return fallback;
  if (!isNonEmptyString(value))
    throw new Error(`${name} must be a non-empty string`);
  return value.trim();
}
function optionalString(value, name) {
  return value === void 0 ? void 0 : stringValue(value, "", name);
}
function booleanValue(value, fallback, name) {
  if (value === void 0) return fallback;
  if (typeof value !== "boolean") throw new Error(`${name} must be boolean`);
  return value;
}
function probabilityValue(value, fallback, name) {
  if (value === void 0) return fallback;
  if (!isFiniteNumber(value) || !inRange(value, 0, 1))
    throw new Error(`${name} must be between 0 and 1`);
  return value;
}
function optionalPositiveNumber(value, name) {
  if (value === void 0) return void 0;
  if (!isFiniteNumber(value) || value <= 0)
    throw new Error(`${name} must be positive`);
  return value;
}
function optionalNonNegativeInteger(value, name) {
  if (value === void 0) return void 0;
  if (!isFiniteNumber(value) || !Number.isInteger(value) || value < 0)
    throw new Error(`${name} must be a non-negative integer`);
  return value;
}
function triggerArray(value, fallback, name) {
  const values = typeof value === "string" ? [value] : value;
  const items = cleanStringArray(values, fallback, name);
  const allowed = new Set(SHADOW_TRIGGERS);
  const invalid = items.filter((item) => !allowed.has(item));
  if (invalid.length)
    throw new Error(`${name} contains invalid trigger: ${invalid.join(", ")}`);
  return items;
}
function optionalThinking(value) {
  if (value === void 0) return void 0;
  if (!isThinkingLevel(value)) throw new Error("thinking_level is invalid");
  return value;
}

// src/entity-store.ts
var EntityStore = class {
  constructor(registry, configPath) {
    this.registry = registry;
    this.configPath = configPath;
  }
  async list() {
    return (await this.registry.load()).shadows;
  }
  async get(id) {
    const shadow = (await this.list()).find((candidate) => candidate.id === id);
    if (!shadow) throw new Error(`shadow not found: ${id}`);
    return shadow;
  }
  async create(draft) {
    if ((await this.list()).some((shadow) => shadow.id === draft.id))
      throw new Error(`shadow already exists: ${draft.id}`);
    return this.writeParsed(
      join3(this.registry.directory, `${draft.id}.md`),
      draft,
      { overwrite: false }
    );
  }
  async update(id, patch) {
    const current = await this.get(id);
    return this.writeParsed(
      current.filePath,
      {
        ...current,
        ...definedOnly(patch),
        id,
        prompt: patch.prompt ?? current.prompt
      },
      { overwrite: true }
    );
  }
  async writeParsed(filePath, draft, options) {
    const source = serializeShadow({
      ...draft,
      prompt: draft.prompt ?? "Describe this Shadow Mind's responsibility."
    });
    const parsed = parseShadowMarkdown(source, filePath);
    await writeFile2(filePath, source, {
      encoding: "utf8",
      ...options.overwrite ? {} : { flag: "wx" }
    });
    return parsed;
  }
  async setEnabled(id, enabled) {
    return this.update(id, { enabled });
  }
  async delete(id) {
    await unlink((await this.get(id)).filePath);
  }
  async readConfig() {
    return readFile3(this.configPath, "utf8");
  }
  async writeConfig(config) {
    await writeFile2(this.configPath, serializeConfig(config), "utf8");
  }
};
function serializeShadow(shadow) {
  const frontmatter = {
    id: shadow.id,
    ...shadow.name !== void 0 ? { name: shadow.name } : {},
    enabled: shadow.enabled ?? true,
    debug: shadow.debug ?? false,
    activation_probability: shadow.activationProbability ?? 0.3,
    trigger: shadow.trigger ?? ["heartbeat"],
    active_for_models: shadow.activeForModels ?? ["*"],
    ...shadow.runWithModel ? { run_with_model: shadow.runWithModel } : {},
    ...shadow.thinkingLevel ? { thinking_level: shadow.thinkingLevel } : {},
    ...shadow.timeoutSeconds !== void 0 ? { timeout_seconds: shadow.timeoutSeconds } : {},
    ...shadow.finalResponseRounds !== void 0 ? { final_response_rounds: shadow.finalResponseRounds } : {},
    ...shadow.activationTools && shadow.activationTools.length ? { activation_tools: shadow.activationTools } : {},
    tools: shadow.tools ?? []
  };
  return `---
${browser_default.stringify(frontmatter).trimEnd()}
---

${(shadow.prompt ?? "").trim()}
`;
}
function describeShadow(shadow) {
  const actTools = shadow.activationTools.length ? ` act_tools=${shadow.activationTools.join(",")}` : "";
  const finalRounds = shadow.finalResponseRounds ? ` final_rounds=${shadow.finalResponseRounds}` : "";
  return `${shadow.enabled ? "enabled" : "disabled"} ${shadow.id} (${shadow.name}) p=${shadow.activationProbability} trigger=${shadow.trigger.join(",")} models=${shadow.activeForModels.join(",")}${finalRounds}${actTools} tools=${shadow.tools.join(",") || "default"} file=${basename2(shadow.filePath)}`;
}
function definedOnly(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== void 0)
  );
}

// src/final-response-budget.ts
var FinalResponseBudget = class {
  counts = /* @__PURE__ */ new Map();
  canRun(shadow) {
    const limit = shadow.finalResponseRounds ?? 0;
    if (limit <= 0) return true;
    return this.used(shadow.id) < limit;
  }
  commit(shadowIds) {
    for (const id of shadowIds) {
      this.counts.set(id, this.used(id) + 1);
    }
  }
  used(shadowId) {
    return this.counts.get(shadowId) ?? 0;
  }
  reset() {
    this.counts.clear();
  }
};

// src/management-tools.ts
import { Type } from "typebox";
var ID = Type.String({ pattern: "^[a-z0-9][a-z0-9_-]*$" });
var THINKING = Type.Union([
  Type.Literal("minimal"),
  Type.Literal("low"),
  Type.Literal("medium"),
  Type.Literal("high"),
  Type.Literal("xhigh"),
  Type.Literal("max")
]);
var TRIGGER = Type.Union([
  Type.Literal("heartbeat"),
  Type.Literal("final_response")
]);
var SHADOW_FIELDS = {
  name: Type.Optional(Type.String()),
  enabled: Type.Optional(Type.Boolean()),
  debug: Type.Optional(Type.Boolean()),
  activation_probability: Type.Optional(
    Type.Number({ minimum: 0, maximum: 1 })
  ),
  trigger: Type.Optional(Type.Array(TRIGGER)),
  active_for_models: Type.Optional(Type.Array(Type.String())),
  run_with_model: Type.Optional(Type.String()),
  thinking_level: Type.Optional(THINKING),
  timeout_seconds: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
  final_response_rounds: Type.Optional(Type.Integer({ minimum: 0 })),
  activation_tools: Type.Optional(Type.Array(Type.String())),
  tools: Type.Optional(Type.Array(Type.String())),
  prompt: Type.Optional(Type.String())
};
function registerManagementTools(pi, store, getConfig) {
  pi.registerTool(listTool(store));
  pi.registerTool(createTool(store));
  pi.registerTool(updateTool(store));
  pi.registerTool(toggleTool(store, true));
  pi.registerTool(toggleTool(store, false));
  pi.registerTool(deleteTool(store));
  pi.registerTool(configReadTool(store));
  pi.registerTool(configWriteTool(store, getConfig));
}
function listTool(store) {
  return tool(
    "list_shadows",
    "List Shadows",
    "List all valid globally configured Shadow Minds.",
    Type.Object({}),
    async () => {
      const shadows = await store.list();
      return textResult(
        shadows.length ? shadows.map(describeShadow).join("\n") : "No Shadow Minds configured."
      );
    }
  );
}
function createTool(store) {
  return tool(
    "create_shadow",
    "Create Shadow",
    "Create a global Shadow Mind definition after user confirmation.",
    Type.Object({ id: ID, ...SHADOW_FIELDS, prompt: Type.String() }),
    async (_id, params, _signal, _update, ctx) => {
      const raw = params;
      if (!await confirm(
        ctx,
        "Create Shadow Mind",
        `Create ${String(raw.id)} in the global registry?`
      ))
        return textResult("Cancelled.");
      const shadow = await store.create(toDraft(raw));
      return textResult(`Created ${describeShadow(shadow)}`);
    }
  );
}
function updateTool(store) {
  return tool(
    "update_shadow",
    "Update Shadow",
    "Update a global Shadow Mind definition after user confirmation. The id is immutable.",
    Type.Object({ id: ID, ...SHADOW_FIELDS }),
    async (_id, params, _signal, _update, ctx) => {
      const raw = params;
      if (!await confirm(
        ctx,
        "Update Shadow Mind",
        `Apply changes to ${String(raw.id)}?`
      ))
        return textResult("Cancelled.");
      const shadow = await store.update(String(raw.id), toPatch(raw));
      return textResult(`Updated ${describeShadow(shadow)}`);
    }
  );
}
function toggleTool(store, enabled) {
  const action = enabled ? "enable" : "disable";
  return tool(
    `${action}_shadow`,
    `${enabled ? "Enable" : "Disable"} Shadow`,
    `${enabled ? "Enable" : "Disable"} a global Shadow Mind after user confirmation.`,
    Type.Object({ id: ID }),
    async (_id, params, _signal, _update, ctx) => {
      const id = String(params.id);
      if (!await confirm(
        ctx,
        `${enabled ? "Enable" : "Disable"} Shadow Mind`,
        `${action} ${id}?`
      ))
        return textResult("Cancelled.");
      return textResult(describeShadow(await store.setEnabled(id, enabled)));
    }
  );
}
function deleteTool(store) {
  return tool(
    "delete_shadow",
    "Delete Shadow",
    "Delete a Shadow Mind definition after user confirmation. Debug logs are retained.",
    Type.Object({ id: ID }),
    async (_id, params, _signal, _update, ctx) => {
      const id = String(params.id);
      if (!await confirm(
        ctx,
        "Delete Shadow Mind",
        `Delete ${id}? Its debug logs will be kept.`
      ))
        return textResult("Cancelled.");
      await store.delete(id);
      return textResult(`Deleted ${id}; logs were retained.`);
    }
  );
}
function configReadTool(store) {
  return tool(
    "get_shadow_config",
    "Get Shadow Config",
    "Read the global Shadow Mind runtime configuration.",
    Type.Object({}),
    async () => textResult(await store.readConfig())
  );
}
function configWriteTool(store, getConfig) {
  return tool(
    "update_shadow_config",
    "Update Shadow Config",
    "Update global Shadow Mind runtime configuration after user confirmation.",
    Type.Object({
      heartbeat_probability: Type.Optional(
        Type.Number({ minimum: 0, maximum: 1 })
      ),
      heartbeat_tools: Type.Optional(Type.Array(Type.String())),
      max_parallel_shadows: Type.Optional(Type.Integer({ minimum: 1 })),
      default_shadow_timeout_seconds: Type.Optional(
        Type.Number({ exclusiveMinimum: 0 })
      ),
      headless_drain_timeout_seconds: Type.Optional(
        Type.Number({ exclusiveMinimum: 0 })
      ),
      result_batch_window_ms: Type.Optional(Type.Integer({ minimum: 0 })),
      excluded_extensions: Type.Optional(Type.Array(Type.String())),
      default_shadow_model: Type.Optional(Type.String()),
      default_thinking_level: Type.Optional(THINKING),
      random_seed: Type.Optional(
        Type.Integer({ minimum: 0, maximum: 4294967295 })
      )
    }),
    async (_id, params, _signal, _update, ctx) => {
      const current = getConfig();
      const raw = params;
      const next = parseConfig({
        heartbeat_probability: raw.heartbeat_probability ?? current.heartbeatProbability,
        heartbeat_tools: raw.heartbeat_tools ?? current.heartbeatTools,
        max_parallel_shadows: raw.max_parallel_shadows ?? current.maxParallelShadows,
        default_shadow_timeout_seconds: raw.default_shadow_timeout_seconds ?? current.defaultShadowTimeoutSeconds,
        headless_drain_timeout_seconds: raw.headless_drain_timeout_seconds ?? current.headlessDrainTimeoutSeconds,
        result_batch_window_ms: raw.result_batch_window_ms ?? current.resultBatchWindowMs,
        excluded_extensions: raw.excluded_extensions ?? current.excludedExtensions,
        default_shadow_model: raw.default_shadow_model ?? current.defaultShadowModel,
        default_thinking_level: raw.default_thinking_level ?? current.defaultThinkingLevel,
        random_seed: raw.random_seed ?? current.randomSeed
      });
      if (!await confirm(
        ctx,
        "Update Shadow Config",
        `Apply this config?
${JSON.stringify(next, null, 2)}`
      ))
        return textResult("Cancelled.");
      await store.writeConfig(next);
      return textResult("Shadow Mind config updated.");
    }
  );
}
function tool(name, label, description, parameters, execute) {
  return { name, label, description, parameters, execute };
}
async function confirm(ctx, title, message) {
  if (!ctx.hasUI)
    throw new Error(
      "This write requires a UI confirmation, but no dialog-capable UI is available."
    );
  return ctx.ui.confirm(title, message);
}
function textResult(text) {
  return { content: [{ type: "text", text }], details: {} };
}
function toDraft(raw) {
  return { id: String(raw.id), ...toPatch(raw) };
}
function toPatch(raw) {
  return {
    name: raw.name,
    enabled: raw.enabled,
    debug: raw.debug,
    activationProbability: raw.activation_probability,
    trigger: raw.trigger,
    activeForModels: raw.active_for_models,
    runWithModel: raw.run_with_model,
    thinkingLevel: raw.thinking_level,
    timeoutSeconds: raw.timeout_seconds,
    finalResponseRounds: raw.final_response_rounds,
    activationTools: raw.activation_tools,
    tools: raw.tools,
    prompt: raw.prompt
  };
}

// src/report-batcher.ts
var ReportBatcher = class {
  constructor(windowMs, deliver) {
    this.windowMs = windowMs;
    this.deliver = deliver;
  }
  reports = [];
  timer;
  deliveries = 0;
  setWindow(windowMs) {
    this.windowMs = windowMs;
  }
  add(report) {
    this.reports.push(report);
    if (this.timer) return;
    this.timer = setTimeout(() => void this.flush(), this.windowMs);
  }
  async flush() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = void 0;
    if (!this.reports.length) return;
    const batch = this.reports;
    this.reports = [];
    this.deliveries += 1;
    try {
      await this.deliver(batch);
    } finally {
      this.deliveries -= 1;
    }
  }
  get hasPending() {
    return this.reports.length > 0 || this.timer !== void 0 || this.deliveries > 0;
  }
  clear() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = void 0;
    this.reports = [];
  }
};
function formatReportBatch(reports) {
  return reports.map((report) => `[${report.shadowName} / ${report.shadowId}]
${report.content}`).join("\n\n");
}

// src/report-history.ts
var ReportHistory = class {
  constructor(limit = 5) {
    this.limit = limit;
    if (!Number.isInteger(limit) || limit < 0) throw new Error("Report limit must be a non-negative integer");
  }
  reports = [];
  add(reports, deliveredAt = (/* @__PURE__ */ new Date()).toISOString()) {
    for (const report of reports) {
      this.reports = this.reports.filter(({ runId }) => runId !== report.runId);
      this.reports.push({ ...report, deliveredAt });
      if (this.reports.length > this.limit) this.reports.shift();
    }
  }
  /** Newest delivery first; callers receive an isolated snapshot. */
  list() {
    return this.reports.map((report) => ({ ...report })).reverse();
  }
  clear() {
    this.reports = [];
  }
};

// src/report-viewer.ts
import { matchesKey, Text, truncateToWidth } from "@earendil-works/pi-tui";
var ReportViewer = class {
  constructor(reports, theme, host) {
    this.theme = theme;
    this.host = host;
    this.body = new Text(reports.map(
      (report) => `${report.shadowName} \xB7 ${report.deliveredAt}
run ${report.runId}
${report.content.replace(/\r\n?/g, "\n")}`
    ).join("\n\n"), 0, 0);
    this.actions = [
      ["escape", () => host.close()],
      ["up", () => this.scroll(-1)],
      ["down", () => this.scroll(1)],
      ["pageUp", () => this.scroll(-this.pageSize)],
      ["pageDown", () => this.scroll(this.pageSize)],
      ["home", () => {
        this.offset = 0;
      }],
      ["end", () => {
        this.offset = this.maxOffset();
      }]
    ];
  }
  body;
  offset = 0;
  contentHeight = 0;
  pageSize = 1;
  actions;
  render(width) {
    const height = Math.max(1, Math.min(Math.floor(this.host.rows() * 0.8), this.host.rows() - 2));
    this.pageSize = Math.max(1, height - 2);
    const lines = this.body.render(Math.max(1, width));
    this.contentHeight = lines.length;
    this.offset = Math.min(this.offset, this.maxOffset());
    const page = lines.slice(this.offset, this.offset + this.pageSize);
    if (height < 3) return page.slice(0, height).map((line) => truncateToWidth(line, width));
    return [
      this.theme.fg("accent", truncateToWidth("Recent Shadow reports \xB7 newest first", width)),
      ...page,
      this.theme.fg("dim", truncateToWidth(
        `Esc close \xB7 \u2191\u2193 PgUp/PgDn Home/End \xB7 ${this.offset + 1}\u2013${Math.min(this.offset + this.pageSize, lines.length)}/${lines.length}`,
        width
      ))
    ];
  }
  handleInput(data) {
    const action = this.actions.find(([key]) => matchesKey(data, key));
    if (!action) return;
    action[1]();
    this.host.requestRender();
  }
  invalidate() {
    this.body.invalidate();
  }
  maxOffset() {
    return Math.max(0, this.contentHeight - this.pageSize);
  }
  scroll(lines) {
    this.offset = Math.max(0, Math.min(this.maxOffset(), this.offset + lines));
  }
};

// src/report-browser.ts
var ReportBrowser = class {
  history = new ReportHistory();
  closeViewer;
  add(reports) {
    this.history.add(reports);
  }
  reset() {
    this.closeViewer?.();
    this.history.clear();
  }
  async handleCommand(command, ctx) {
    const [name, ...args] = command.split(/\s+/);
    if (name !== "reports") return false;
    if (args.length && args.join(" ") !== "hide") {
      ctx.ui.notify("Usage: /shadow reports [hide]", "warning");
      return true;
    }
    if (args[0] === "hide" || this.closeViewer) {
      this.closeViewer?.();
      return true;
    }
    if (ctx.mode !== "tui") {
      if (ctx.hasUI) ctx.ui.notify("The report viewer requires TUI mode. Delivered reports remain in the conversation.", "warning");
      return true;
    }
    const reports = this.history.list();
    if (!reports.length) {
      ctx.ui.notify("No reports delivered in this session yet.", "info");
      return true;
    }
    const view = { close: () => {
    } };
    try {
      await ctx.ui.custom((tui, theme, _keys, done) => {
        view.close = () => {
          if (this.closeViewer !== view.close) return;
          this.closeViewer = void 0;
          done();
        };
        this.closeViewer = view.close;
        return new ReportViewer(reports, theme, {
          rows: () => tui.terminal.rows,
          requestRender: () => tui.requestRender(),
          close: view.close
        });
      }, { overlay: true, overlayOptions: { width: "90%", maxHeight: "80%", margin: 1 } });
    } finally {
      if (this.closeViewer === view.close) this.closeViewer = void 0;
    }
    return true;
  }
};

// src/random.ts
function createRandom(seed) {
  if (seed === void 0) return Math.random;
  let state = seed >>> 0;
  return () => {
    state = state + 1831565813 >>> 0;
    let value = state;
    value = Math.imul(value ^ value >>> 15, value | 1);
    value ^= value + Math.imul(value ^ value >>> 7, value | 61);
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  };
}

// src/acp-projection.ts
import {
  buildContextEntries,
  buildSessionContext,
  sessionEntryToContextMessages
} from "@earendil-works/pi-coding-agent";

// src/acp-state.ts
import { readFileSync } from "node:fs";
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function readAcpBlocks(sessionFile) {
  if (!sessionFile) return [];
  try {
    const state = JSON.parse(readFileSync(`${sessionFile}.acp.json`, "utf8"));
    if (!isRecord(state) || !Array.isArray(state.blocks)) return [];
    const blocks = [];
    const seen = /* @__PURE__ */ new Set();
    for (const block of state.blocks) {
      if (!isRecord(block)) return [];
      if (block.active === false) continue;
      if (block.active !== true || typeof block.blockId !== "string" || !block.blockId || typeof block.summary !== "string" || !block.summary.trim() || !Array.isArray(block.effectiveMessageIds) || !block.effectiveMessageIds.every((id) => typeof id === "string" && id.length > 0) || seen.has(block.blockId)) return [];
      seen.add(block.blockId);
      blocks.push({
        blockId: block.blockId,
        summary: block.summary,
        effectiveMessageIds: [...block.effectiveMessageIds]
      });
    }
    return blocks;
  } catch {
    return [];
  }
}

// src/acp-projection.ts
function buildShadowSessionContext(entries, leafId, sessionFile) {
  const context = buildSessionContext(entries, leafId);
  const blocks = readAcpBlocks(sessionFile);
  if (!blocks.length) return context;
  const visible = buildContextEntries(entries, leafId).flatMap(
    (entry) => sessionEntryToContextMessages(entry).map((message) => ({ id: entry.id, message }))
  );
  return { ...context, messages: projectMessages(visible, blocks) };
}
function toolCalls(message) {
  return message.role === "assistant" ? message.content.filter((part) => part.type === "toolCall") : [];
}
function coverageIds({ id, message }) {
  const calls = toolCalls(message);
  return calls.length > 1 ? calls.map((call) => `${id}#${call.id}`) : [id];
}
function summaryMessage(block) {
  return {
    role: "compactionSummary",
    summary: `[ACP block ${block.blockId} \u2014 ${block.effectiveMessageIds.length} folded messages]
${block.summary}`,
    tokensBefore: 0,
    timestamp: 0
  };
}
function projectMessages(visible, blocks) {
  const indexById = /* @__PURE__ */ new Map();
  visible.forEach((item, index) => {
    for (const id of coverageIds(item)) indexById.set(id, index);
  });
  const covered = /* @__PURE__ */ new Set();
  const anchors = /* @__PURE__ */ new Map();
  for (const block of blocks) {
    const positions = block.effectiveMessageIds.flatMap((id) => {
      const index = indexById.get(id);
      return index === void 0 ? [] : [index];
    });
    if (!positions.length) continue;
    const first = positions.reduce((left, right) => Math.min(left, right));
    anchors.set(first, [...anchors.get(first) ?? [], block]);
    for (const id of block.effectiveMessageIds) covered.add(id);
  }
  if (!covered.size) return visible.map(({ message }) => message);
  const firstUser = visible.findIndex(
    ({ message }) => message.role === "user" || message.role === "custom"
  );
  const messages = [];
  visible.forEach((item, index) => {
    for (const block of anchors.get(index) ?? []) messages.push(summaryMessage(block));
    const retained = index === firstUser ? item.message : retainUncovered(item, covered);
    if (retained) messages.push(retained);
  });
  return removeOrphanedTools(messages);
}
function retainUncovered(item, covered) {
  const ids = coverageIds(item);
  if (!ids.some((id) => covered.has(id))) return item.message;
  if (ids.every((id) => covered.has(id))) return void 0;
  const message = item.message;
  if (message.role !== "assistant") return message;
  return {
    ...message,
    content: message.content.filter(
      (part) => part.type !== "toolCall" || !covered.has(`${item.id}#${part.id}`)
    )
  };
}
function removeOrphanedTools(messages) {
  const resultIds = new Set(messages.flatMap(
    (message) => message.role === "toolResult" ? [message.toolCallId] : []
  ));
  const paired = messages.flatMap((message) => {
    const calls = toolCalls(message);
    if (!calls.length || message.role !== "assistant") return [message];
    const retained = calls.filter((call) => call.name === "compress" || resultIds.has(call.id));
    if (!retained.length) return [];
    const ids = new Set(retained.map((call) => call.id));
    return [{ ...message, content: message.content.filter((part) => part.type !== "toolCall" || ids.has(part.id)) }];
  });
  const callIds = new Set(paired.flatMap((message) => toolCalls(message).map((call) => call.id)));
  return paired.filter((message) => message.role !== "toolResult" || callIds.has(message.toolCallId));
}

// src/scheduler.ts
function extractToolNames(toolResults) {
  const names = /* @__PURE__ */ new Set();
  for (const item of toolResults) {
    if (!item || typeof item !== "object") continue;
    const name = item.toolName;
    if (typeof name === "string" && name.trim().length > 0) {
      names.add(name.trim());
    }
  }
  return names;
}
function shouldEvaluateHeartbeat(toolsOrResults, heartbeatTools) {
  const toolNames = toolsOrResults instanceof Set ? toolsOrResults : extractToolNames(toolsOrResults);
  if (toolNames.size === 0) return false;
  if (!heartbeatTools || heartbeatTools.length === 0) return true;
  return heartbeatTools.some((tool2) => toolNames.has(tool2));
}
function shouldEvaluateFinalResponse(messages) {
  const message = messages.at(-1);
  if (!message || typeof message !== "object" || message.role !== "assistant")
    return false;
  const content = message.content;
  if (typeof content === "string") return content.trim().length > 0;
  return Array.isArray(content) && content.some((block) => {
    if (!block || typeof block !== "object") return false;
    const value = block;
    return value.type === "text" && typeof value.text === "string" && value.text.trim().length > 0;
  });
}
function decideHeartbeat(options) {
  const random = options.random ?? Math.random;
  const heartbeatRoll = random();
  if (heartbeatRoll >= options.heartbeatProbability || options.availableSlots <= 0) {
    return {
      heartbeatRoll,
      activated: [],
      candidates: [],
      modelFiltered: [],
      runningExcluded: [],
      roundFiltered: [],
      toolFiltered: []
    };
  }
  const modelFiltered = [];
  const runningExcluded = [];
  const toolFiltered = [];
  const rolls = options.shadows.filter((shadow) => {
    if (!shadow.enabled || !hasTrigger(shadow, "heartbeat")) return false;
    if (options.activeShadowIds.has(shadow.id)) {
      runningExcluded.push(shadow.id);
      return false;
    }
    if (!matchesModel(shadow, options.mainModelId)) {
      modelFiltered.push(shadow.id);
      return false;
    }
    if (!matchesActivationTools(shadow, options.executedTools)) {
      toolFiltered.push(shadow.id);
      return false;
    }
    return true;
  }).map((shadow) => ({ shadow, roll: random() }));
  const hits = rolls.filter(
    ({ shadow, roll }) => roll < shadow.activationProbability
  );
  const selected = sample(
    hits,
    Math.min(options.availableSlots, hits.length),
    random
  );
  const selectedIds = new Set(selected.map(({ shadow }) => shadow.id));
  return {
    heartbeatRoll,
    activated: selected,
    candidates: rolls.map(({ shadow, roll }) => ({
      shadowId: shadow.id,
      roll,
      selected: selectedIds.has(shadow.id)
    })),
    modelFiltered,
    runningExcluded,
    roundFiltered: [],
    toolFiltered
  };
}
function decideFinalResponse(options) {
  const modelFiltered = [];
  const roundFiltered = [];
  const candidates = options.shadows.filter((shadow) => {
    if (!shadow.enabled || !hasTrigger(shadow, "final_response"))
      return false;
    if (!matchesModel(shadow, options.mainModelId)) {
      modelFiltered.push(shadow.id);
      return false;
    }
    if (options.canRunFinalResponse && !options.canRunFinalResponse(shadow)) {
      roundFiltered.push(shadow.id);
      return false;
    }
    return true;
  }).map((shadow) => ({ shadow, roll: 0 }));
  return {
    activated: candidates,
    candidates: candidates.map(({ shadow, roll }) => ({
      shadowId: shadow.id,
      roll,
      selected: true
    })),
    modelFiltered,
    runningExcluded: [],
    roundFiltered
  };
}
function matchesModel(shadow, fullModelId) {
  if (!shadow.activeForModels || shadow.activeForModels.length === 0) {
    return false;
  }
  const negatives = [];
  const positives = [];
  for (const item of shadow.activeForModels) {
    const trimmed = item.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("!")) {
      const pattern = trimmed.slice(1).trim();
      if (pattern) negatives.push(pattern);
    } else {
      positives.push(trimmed);
    }
  }
  for (const neg of negatives) {
    if (modelPatternMatches(neg, fullModelId)) {
      return false;
    }
  }
  if (positives.length === 0) {
    return negatives.length > 0;
  }
  return positives.some((pos) => modelPatternMatches(pos, fullModelId));
}
function modelPatternMatches(pattern, fullModelId) {
  if (pattern === "*") return true;
  if (pattern === fullModelId) return true;
  const slashIndex = fullModelId.indexOf("/");
  const modelId = slashIndex !== -1 ? fullModelId.slice(slashIndex + 1) : fullModelId;
  if (!pattern.includes("/") && pattern === modelId) {
    return true;
  }
  if (pattern.includes("*")) {
    const regex = wildcardToRegex(pattern);
    if (regex.test(fullModelId)) return true;
    if (!pattern.includes("/") && regex.test(modelId)) return true;
  }
  return false;
}
function wildcardToRegex(pattern) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped.replace(/\*/g, ".*")}$`);
}
function matchesActivationTools(shadow, executedTools) {
  if (shadow.activationTools.length === 0) {
    return true;
  }
  if (!executedTools) return false;
  const executedSet = executedTools instanceof Set ? executedTools : new Set(executedTools);
  return shadow.activationTools.some((tool2) => executedSet.has(tool2));
}
function hasTrigger(shadow, trigger) {
  return shadow.trigger.includes(trigger);
}
function sample(values, count, random) {
  const copy = [...values];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    [copy[index], copy[swap]] = [copy[swap], copy[index]];
  }
  return copy.slice(0, count);
}

// src/session-lifetime.ts
var STALE_CONTEXT_MARKER = "This extension ctx is stale after session replacement or reload";
var SessionLifetime = class {
  active = false;
  activate() {
    this.active = true;
  }
  deactivate() {
    this.active = false;
  }
  get isActive() {
    return this.active;
  }
  run(action) {
    if (!this.active) return false;
    try {
      action();
      return true;
    } catch (error) {
      if (!isStaleExtensionContextError(error)) throw error;
      this.active = false;
      return false;
    }
  }
};
function isStaleExtensionContextError(error) {
  return error instanceof Error && error.message.includes(STALE_CONTEXT_MARKER);
}

// src/shadow-runner.ts
import { mkdir as mkdir3 } from "node:fs/promises";
import { join as join5 } from "node:path";
import { Type as Type2 } from "typebox";
import {
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  createAgentSession
} from "@earendil-works/pi-coding-agent";

// src/usage.ts
function zeroUsage() {
  return {
    requests: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0
    }
  };
}
function addUsage(left, right) {
  return {
    requests: left.requests + right.requests,
    input: left.input + right.input,
    output: left.output + right.output,
    cacheRead: left.cacheRead + right.cacheRead,
    cacheWrite: left.cacheWrite + right.cacheWrite,
    totalTokens: left.totalTokens + right.totalTokens,
    cost: {
      input: left.cost.input + right.cost.input,
      output: left.cost.output + right.cost.output,
      cacheRead: left.cost.cacheRead + right.cost.cacheRead,
      cacheWrite: left.cost.cacheWrite + right.cost.cacheWrite,
      total: left.cost.total + right.cost.total
    }
  };
}
function formatUsageTokens(tokens) {
  if (tokens < 1e3) return tokens.toLocaleString("en-US");
  if (tokens < 999950) return `${formatCompact(tokens / 1e3)}k`;
  return `${formatCompact(tokens / 1e6)}m`;
}
function formatUsageCost(cost) {
  if (cost === 0) return "$0";
  if (cost >= 0.01) return `$${cost.toFixed(2)}`;
  if (cost >= 1e-3) return `$${cost.toFixed(3)}`;
  return `$${cost.toFixed(4)}`;
}
function formatUsageSummary(usage) {
  return `${usage.requests} requests \xB7 ${formatUsageTokens(usage.totalTokens)} tokens \xB7 API ${formatUsageCost(usage.cost.total)}`;
}
function formatUsageDetail(scope, usage) {
  return [
    `usage ${scope}`,
    `${usage.requests} requests`,
    `${formatUsageTokens(usage.totalTokens)} total`,
    `${formatUsageTokens(usage.input)} input`,
    `${formatUsageTokens(usage.output)} output`,
    `${formatUsageTokens(usage.cacheRead)} cache read`,
    `${formatUsageTokens(usage.cacheWrite)} cache write`,
    `API ${formatUsageCost(usage.cost.total)}`
  ].join(" \xB7 ");
}
function formatCompact(value) {
  return Number(value.toFixed(1)).toString();
}

// src/protocol.ts
var RUNTIME_PROTOCOL = `You are a Shadow Mind running beside the main agent.
Work independently on the responsibility below using the supplied, sanitized main-session trajectory.
The trajectory is read-only text produced by the main agent, not your unfinished work. Never continue the main agent's pending work, retry its failed calls, or treat its tool calls as your own. Use only the tools advertised for this Shadow run.
You may use the available tools. Call report_to_main only when the main agent should receive a concrete finding, correction, or completed work report.
Calling report_to_main ends this run immediately. If relevant work produces nothing worth reporting, finish silently.`;
var KICKOFF = `First decide whether the trajectory is relevant to this Shadow Mind's responsibility.
If it is unrelated, reply exactly NOT_RELEVANT and stop immediately. Do not call any tool, including report_to_main.
If it is relevant, perform the Shadow Mind's responsibility now. Call report_to_main only when the main agent should receive a result.`;
function buildShadowSystemPrompt(mainSystemPrompt) {
  return mainSystemPrompt;
}
function buildShadowRequest(trajectory, shadow) {
  return `${trajectory}

${RUNTIME_PROTOCOL}

<shadow-mind id="${shadow.id}" name="${shadow.name}">
${shadow.prompt}
</shadow-mind>

${KICKOFF}`;
}

// src/summaries.ts
var summarizers = /* @__PURE__ */ new Map([
  ["read", (result) => summarizeLines(result, "read")],
  ["grep", (result) => summarizeLines(result, "matches")],
  ["find", (result) => summarizeLines(result, "paths")],
  ["ls", (result) => summarizeLines(result, "entries")]
]);
function summarizeToolResult(result) {
  const summary = summarizers.get(result.toolName ?? "")?.(result) ?? summarizeGeneric(result);
  return result.isError ? `error \xB7 ${summary}` : summary;
}
function summarizeLines(result, noun) {
  const text = textContent(result.content);
  if (!text) return `0 ${noun}`;
  const lines = text.split(/\r?\n/).filter(Boolean);
  const preview = compact(lines[0] ?? "");
  return `${lines.length} ${noun}${preview ? ` \xB7 ${preview}` : ""}`;
}
function summarizeGeneric(result) {
  return describeContent(result.content) ?? "no output";
}
function describeContent(content) {
  if (Array.isArray(content)) {
    const blocks = content.filter((block) => Boolean(block) && typeof block === "object");
    if (!blocks.length) return "empty result";
    const counts = /* @__PURE__ */ new Map();
    for (const block of blocks) {
      const type = block.type ?? "object";
      counts.set(type, (counts.get(type) ?? 0) + 1);
    }
    return [...counts.entries()].map(([type, count]) => `${count} ${type}${count > 1 ? "s" : ""}`).join(" \xB7 ");
  }
  if (content === null) return "null";
  if (typeof content === "string") return `text \xB7 ${content.length} chars`;
  if (typeof content === "number" || typeof content === "boolean") return `${typeof content} \xB7 ${String(content)}`;
  if (typeof content === "object") return `object \xB7 ${Object.keys(content).length} keys`;
  return void 0;
}
function textContent(content) {
  if (!Array.isArray(content)) return "";
  return content.filter((part) => Boolean(part) && typeof part === "object" && part.type === "text").map((part) => part.text ?? "").join("\n");
}
function compact(value) {
  return value.replace(/\s+/g, " ").trim();
}

// src/trajectory.ts
function serializeTrajectory(messages) {
  const results = /* @__PURE__ */ new Map();
  for (const message of messages) {
    if (message.role === "toolResult" && typeof message.toolCallId === "string") {
      results.set(message.toolCallId, summarizeToolResult(message));
    }
  }
  const lines = [];
  for (const message of messages) {
    if (message.role === "user") {
      appendText(lines, "USER", message.content);
      continue;
    }
    if (message.role === "assistant") {
      if (!Array.isArray(message.content)) {
        appendText(lines, "MAIN", message.content);
        continue;
      }
      for (const block of message.content) {
        if (!block || typeof block !== "object" || isThinkingBlock(block)) continue;
        const item = block;
        if (item.type === "text" && item.text) lines.push(`MAIN: ${item.text}`);
        if (item.type === "toolCall" && item.name) {
          const call = `${item.name}(${compactJson(item.arguments)})`;
          const result = item.id ? results.get(item.id) : void 0;
          lines.push(`TOOL: ${call}${result ? ` \xB7 ${result}` : ""}`);
        }
      }
      continue;
    }
    if (message.role === "toolResult") {
      if (typeof message.toolCallId !== "string" || !results.has(message.toolCallId)) {
        lines.push(`TOOL RESULT: ${summarizeToolResult(message)}`);
      }
      continue;
    }
    if (message.role === "custom" && message.customType === "shadow-report") {
      appendText(lines, "SHADOW FEEDBACK", message.content);
      continue;
    }
    if (message.role === "compactionSummary" || message.role === "branchSummary") {
      appendText(lines, "SUMMARY", message.summary ?? message.content);
    }
  }
  return `<main-agent-trajectory>
${lines.join("\n")}
</main-agent-trajectory>`;
}
function isThinkingBlock(value) {
  return Boolean(value) && typeof value === "object" && value.type === "thinking";
}
function appendText(lines, label, content) {
  const text = extractText(content);
  if (text) lines.push(`${label}: ${text}`);
}
function extractText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((item) => Boolean(item) && typeof item === "object").filter((item) => item.type === "text" && typeof item.text === "string").map((item) => item.text).join("\n");
}
function compactJson(value) {
  if (value === void 0) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return "[unserializable]";
  }
}

// src/extension-filter.ts
import { readFileSync as readFileSync2 } from "node:fs";
import { homedir } from "node:os";
import { basename as basename3, dirname as dirname2, join as join4, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
var SELF_PATH = normalize(resolve(fileURLToPath(import.meta.url)));
var SELF_DIRECTORY = dirname2(SELF_PATH);
var SELF_ENTRIES = /* @__PURE__ */ new Set(["index.ts", "index.js"]);
function isSelfExtension(candidate) {
  const normalized = normalize(resolve(candidate));
  if (normalized === SELF_PATH) return true;
  return dirname2(normalized) === SELF_DIRECTORY && SELF_ENTRIES.has(basename3(normalized));
}
var PACKAGE_LOOKUP_DEPTH = 4;
var GENERIC_ENTRY_FILE = /^index\.[^.]+$/;
var packageNameCache = /* @__PURE__ */ new Map();
function extensionIdentifiers(resolvedPath) {
  const normalized = normalize(resolve(resolvedPath));
  const identifiers = /* @__PURE__ */ new Set([normalized]);
  const owner = findPackage(dirname2(normalized));
  if (owner) {
    identifiers.add(owner.name);
    identifiers.add(basename3(owner.directory));
    identifiers.add(owner.directory);
  }
  const fileName = basename3(normalized);
  if (!GENERIC_ENTRY_FILE.test(fileName)) {
    identifiers.add(fileName);
    identifiers.add(fileName.replace(/\.[^.]+$/, ""));
  }
  return identifiers;
}
function createExtensionExcluder(entries) {
  const wanted = /* @__PURE__ */ new Set();
  for (const entry of entries) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    wanted.add(trimmed);
    wanted.add(stripScheme(trimmed));
    wanted.add(normalize(resolve(expandHome(trimmed))));
  }
  if (wanted.size === 0) return () => false;
  return (resolvedPath) => {
    for (const identifier of extensionIdentifiers(resolvedPath)) {
      if (wanted.has(identifier)) return true;
    }
    return false;
  };
}
function findPackage(directory) {
  if (packageNameCache.has(directory)) return packageNameCache.get(directory);
  const home = resolve(homedir());
  let current = directory;
  let found;
  for (let depth = 0; depth < PACKAGE_LOOKUP_DEPTH; depth += 1) {
    if (basename3(current) === "node_modules" || current === home) break;
    const name = readPackageName(current);
    if (name) {
      found = { name, directory: current };
      break;
    }
    const parent = dirname2(current);
    if (parent === current) break;
    current = parent;
  }
  packageNameCache.set(directory, found);
  return found;
}
function readPackageName(directory) {
  try {
    const parsed = JSON.parse(readFileSync2(join4(directory, "package.json"), "utf8"));
    const name = parsed.name;
    return typeof name === "string" && name.trim() ? name.trim() : void 0;
  } catch {
    return void 0;
  }
}
function stripScheme(source) {
  return source.replace(/^[a-z][a-z0-9+.-]+:/i, "");
}
function expandHome(entry) {
  return entry === "~" || entry.startsWith("~/") ? resolve(homedir(), entry.slice(2)) : entry;
}

// src/shadow-runner.ts
function resolveShadowTools(whitelist, available, defaults = DEFAULT_READ_TOOLS) {
  const builtin = /* @__PURE__ */ new Set(["report_to_main"]);
  const requested = whitelist.includes("*") ? [.../* @__PURE__ */ new Set([...available, ...builtin])] : [.../* @__PURE__ */ new Set([...defaults, ...whitelist, ...builtin])];
  const tools = [];
  const missing = [];
  for (const name of requested) {
    (builtin.has(name) || available.has(name) ? tools : missing).push(name);
  }
  return { tools, missing };
}
function runReason(timedOut, reported, aborted, failed = false) {
  if (timedOut) return "timeout";
  if (reported) return "report";
  if (aborted) return "aborted";
  return failed ? "error" : "silent";
}
function buildRunResult(options) {
  const { reason, error, durationMs, session, baseMessageCount, missingTools, thinkingLevel } = options;
  const ownMessages = session ? session.messages.slice(baseMessageCount) : [];
  const metrics = toolMetrics(ownMessages);
  const usage = usageMetrics(ownMessages);
  return {
    reason,
    ...error === void 0 ? {} : { error },
    durationMs,
    toolNames: session?.getActiveToolNames() ?? [],
    missingTools,
    ...metrics,
    usage,
    ...thinkingLevel === void 0 ? {} : { thinkingLevel },
    sessionFile: session?.sessionFile
  };
}
var ShadowRunner = class {
  controllers = /* @__PURE__ */ new Map();
  async run(request) {
    const started = Date.now();
    const controller = new AbortController();
    this.controllers.set(request.runId, { controller });
    const state = { reported: false, timedOut: false };
    let finalReason = "error";
    let sessionManager;
    let timeout;
    let missingTools = [];
    let baseMessageCount = 0;
    let thinkingLevel;
    try {
      const model = resolveRunModel(request);
      assertShadowModelAuth(model, request);
      const trajectory = serializeTrajectory(request.messages);
      assertTrajectoryFits(model, [trajectory]);
      sessionManager = await createShadowSessionManager(request);
      const boot = await this.bootstrapSession(request, model, controller, state, sessionManager);
      state.session = boot.session;
      missingTools = boot.missingTools;
      thinkingLevel = boot.thinkingLevel;
      baseMessageCount = boot.session.messages.length;
      this.controllers.set(request.runId, { controller, session: boot.session });
      if (controller.signal.aborted) {
        finalReason = "aborted";
        return buildRunResult({ reason: finalReason, durationMs: Date.now() - started, session: boot.session, baseMessageCount, missingTools, thinkingLevel });
      }
      const timeoutMs = (request.shadow.timeoutSeconds ?? request.config.defaultShadowTimeoutSeconds) * 1e3;
      timeout = setTimeout(() => {
        state.timedOut = true;
        controller.abort();
        void boot.session?.abort();
      }, timeoutMs);
      controller.signal.addEventListener("abort", () => void boot.session?.abort(), { once: true });
      await boot.session.prompt(buildShadowRequest(trajectory, request.shadow));
      await boot.session.waitForIdle();
      finalReason = runReason(state.timedOut, state.reported, controller.signal.aborted);
      return buildRunResult({ reason: finalReason, durationMs: Date.now() - started, session: boot.session, baseMessageCount, missingTools, thinkingLevel });
    } catch (error) {
      finalReason = runReason(state.timedOut, state.reported, controller.signal.aborted, true);
      return buildRunResult({ reason: finalReason, error: error instanceof Error ? error.message : String(error), durationMs: Date.now() - started, session: state.session, baseMessageCount, missingTools, thinkingLevel });
    } finally {
      if (timeout) clearTimeout(timeout);
      sessionManager?.appendCustomEntry("shadow-mind-run-end", { runId: request.runId, reason: finalReason, durationMs: Date.now() - started });
      state.session?.dispose();
      this.controllers.delete(request.runId);
    }
  }
  /** Build the shadow AgentSession (loader, report tool, allowlist) and validate it. */
  async bootstrapSession(request, model, controller, state, sessionManager) {
    const thinkingLevel = resolveRunThinkingLevel(model, request);
    const settingsManager = SettingsManager.create(request.cwd, request.agentDir);
    const isExcluded = createExtensionExcluder(request.config.excludedExtensions);
    const resourceLoader = new DefaultResourceLoader({
      cwd: request.cwd,
      agentDir: request.agentDir,
      settingsManager,
      systemPrompt: buildShadowSystemPrompt(request.mainSystemPrompt),
      // The inherited main system prompt already embeds APPEND_SYSTEM.md,
      // AGENTS.md and skills; keep the loader from re-discovering them so the
      // shadow context stays a strict subset (no duplication).
      appendSystemPrompt: [],
      agentsFilesOverride: () => ({ agentsFiles: [] }),
      skillsOverride: (base) => ({ skills: [], diagnostics: base.diagnostics }),
      // Drop this plugin itself plus every extension the user excluded, so
      // session-scoped extensions (archivers, recorders) never treat an internal
      // Shadow run as one more user session.
      extensionsOverride: (base) => ({
        ...base,
        extensions: base.extensions.filter(
          (extension) => !isSelfExtension(extension.resolvedPath) && !isExcluded(extension.resolvedPath)
        )
      })
    });
    await resourceLoader.reload();
    const reportTool = createReportTool((content) => {
      if (state.reported || controller.signal.aborted) return;
      state.reported = true;
      request.onReport({
        shadowId: request.shadow.id,
        shadowName: request.shadow.name,
        content,
        epoch: request.epoch,
        runId: request.runId
      });
      queueMicrotask(() => void state.session?.abort());
    });
    const tools = [...new Set(request.tools)];
    const created = await createAgentSession({
      cwd: request.cwd,
      agentDir: request.agentDir,
      model,
      thinkingLevel,
      tools,
      customTools: [reportTool],
      resourceLoader,
      sessionManager,
      settingsManager
    });
    const missingTools = tools.filter((name) => !created.session.getActiveToolNames().includes(name));
    return { session: created.session, missingTools, thinkingLevel };
  }
  abort(runId) {
    this.controllers.get(runId)?.controller.abort();
  }
  abortAll() {
    for (const { controller } of this.controllers.values()) controller.abort();
  }
};
function toolMetrics(messages) {
  const stats = /* @__PURE__ */ new Map();
  for (const message of messages) {
    if (message.role !== "toolResult") continue;
    const tool2 = message.toolName ?? "unknown";
    const entry = stats.get(tool2) ?? { tool: tool2, calls: 0, failures: 0 };
    entry.calls += 1;
    if (message.isError) entry.failures += 1;
    stats.set(tool2, entry);
  }
  const toolStats = [...stats.values()].sort((a, b) => b.calls - a.calls);
  return {
    toolCalls: toolStats.reduce((sum, stat3) => sum + stat3.calls, 0),
    toolFailures: toolStats.reduce((sum, stat3) => sum + stat3.failures, 0),
    toolStats
  };
}
function usageMetrics(messages) {
  let aggregate = zeroUsage();
  for (const message of messages) {
    if (message.role !== "assistant" || !message.usage) continue;
    aggregate = addUsage(aggregate, {
      requests: 1,
      input: message.usage.input,
      output: message.usage.output,
      cacheRead: message.usage.cacheRead,
      cacheWrite: message.usage.cacheWrite,
      totalTokens: message.usage.totalTokens,
      cost: {
        input: message.usage.cost.input,
        output: message.usage.cost.output,
        cacheRead: message.usage.cost.cacheRead,
        cacheWrite: message.usage.cost.cacheWrite,
        total: message.usage.cost.total
      }
    });
  }
  return aggregate;
}
function createReportTool(onReport) {
  return {
    name: "report_to_main",
    label: "Report to Main",
    description: "Report a concrete finding or completed result to the main agent and immediately end this Shadow Mind run.",
    promptSnippet: "Report a useful result to the main agent and end this run",
    parameters: Type2.Object({ content: Type2.String({ description: "The complete report for the main agent" }) }),
    async execute(_toolCallId, params) {
      const content = params.content;
      onReport(content);
      return { content: [{ type: "text", text: "Report delivered." }], details: {}, terminate: true };
    }
  };
}
async function createShadowSessionManager(request) {
  if (!request.shadow.debug) return SessionManager.inMemory(request.cwd);
  const directory = join5(request.agentDir, "shadow-minds", "logs", request.shadow.id);
  await mkdir3(directory, { recursive: true });
  const manager = SessionManager.create(request.cwd, directory);
  manager.appendCustomEntry("shadow-mind-run", { runId: request.runId, epoch: request.epoch, shadowId: request.shadow.id });
  return manager;
}
function resolveRunModel(request) {
  const fullId = request.shadow.runWithModel ?? request.config.defaultShadowModel;
  if (!fullId) return request.mainModel;
  const model = request.resolveModel(fullId);
  if (!model) throw new Error(`shadow model not found: ${fullId}`);
  return model;
}
function assertShadowModelAuth(model, request) {
  if (request.modelAuthOk && !request.modelAuthOk(model)) {
    throw new Error(`shadow model ${model.provider}/${model.id} has no configured auth`);
  }
}
function resolveRunThinkingLevel(model, request) {
  const candidates = [request.shadow.thinkingLevel, request.config.defaultThinkingLevel, request.mainThinkingLevel].filter((level) => level !== void 0);
  for (const level of candidates) {
    if (model.thinkingLevelMap?.[level] !== null) return level;
  }
  throw new Error(`no supported thinking level for ${model.provider}/${model.id} (tried: ${candidates.join(", ") || "none"})`);
}
function assertTrajectoryFits(model, messages) {
  const chars = messages.reduce((sum, message) => sum + (JSON.stringify(message)?.length ?? 0), 0);
  const estimated = Math.ceil(chars / 2);
  if (estimated > model.contextWindow) {
    throw new Error(`trajectory ~${estimated} tokens exceeds ${model.provider}/${model.id} context window (${model.contextWindow})`);
  }
}

// src/shutdown-drain.ts
async function waitForSettled(options) {
  const pollMs = options.pollMs ?? 25;
  const quietMs = options.quietMs ?? 50;
  const now = options.now ?? Date.now;
  const delay2 = options.delay ?? ((ms) => new Promise((resolve2) => setTimeout(resolve2, ms)));
  const started = now();
  let settledSince;
  while (now() - started < options.timeoutMs) {
    if (options.isSettled()) {
      settledSince ??= now();
      if (now() - settledSince >= quietMs) return { settled: true, durationMs: now() - started };
    } else {
      settledSince = void 0;
    }
    const remaining = options.timeoutMs - (now() - started);
    await delay2(Math.min(pollMs, Math.max(1, remaining)));
  }
  return { settled: false, durationMs: now() - started };
}

// src/usage-store.ts
import { randomUUID as randomUUID2 } from "node:crypto";
import { mkdir as mkdir5, readFile as readFile5, rename as rename2, rm as rm2, writeFile as writeFile4 } from "node:fs/promises";
import { dirname as dirname3, join as join7 } from "node:path";

// src/usage-file-lock.ts
import { randomUUID } from "node:crypto";
import { mkdir as mkdir4, readFile as readFile4, rename, rm, stat as stat2, utimes, writeFile as writeFile3 } from "node:fs/promises";
import { join as join6 } from "node:path";
var USAGE_LOCK_OWNER_FILE = "owner";
var USAGE_LOCK_OPERATION_DIRECTORY = ".operation";
async function acquireUsageFileLock(usagePath, timing = {}) {
  const resolved = resolveTiming(timing);
  const lockPath = `${usagePath}.lock`;
  const owner = { token: randomUUID(), pid: process.pid };
  while (true) {
    try {
      await mkdir4(lockPath);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      await recoverStaleUsageLock(lockPath, resolved);
      await delay(resolved.retryMs);
      continue;
    }
    try {
      await writeOwner(lockPath, owner);
    } catch (error) {
      await rm(lockPath, { recursive: true, force: true }).catch(() => void 0);
      throw error;
    }
    return startLease(lockPath, owner, resolved);
  }
}
function startLease(lockPath, owner, timing) {
  let stopped = false;
  let heartbeat = Promise.resolve();
  const timer = setInterval(() => {
    heartbeat = heartbeat.then(async () => {
      if (stopped) return;
      const current = await readUsageLockState(lockPath);
      if (!current || current.owner?.token !== owner.token) {
        stopped = true;
        return;
      }
      const now = /* @__PURE__ */ new Date();
      await utimes(join6(lockPath, USAGE_LOCK_OWNER_FILE), now, now);
    }).catch(() => void 0);
  }, timing.heartbeatMs);
  timer.unref();
  return async () => {
    stopped = true;
    clearInterval(timer);
    await heartbeat;
    await releaseUsageLock(lockPath, owner.token, timing);
  };
}
async function recoverStaleUsageLock(lockPath, timing) {
  const observed = await readUsageLockState(lockPath);
  if (!observed || !isRecoverableUsageLock(observed, timing.staleMs)) return;
  const operationPath = join6(lockPath, USAGE_LOCK_OPERATION_DIRECTORY);
  if (!await claimUsageLockOperation(operationPath, timing)) return;
  try {
    const current = await readUsageLockState(lockPath);
    if (!current || !sameUsageLock(current, observed) || !isRecoverableUsageLock(current, timing.staleMs)) return;
    const abandonedPath = `${lockPath}.${randomUUID()}.stale`;
    try {
      await rename(lockPath, abandonedPath);
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    await rm(abandonedPath, { recursive: true, force: true });
  } finally {
    await rm(operationPath, { recursive: true, force: true }).catch(() => void 0);
  }
}
async function releaseUsageLock(lockPath, token, timing) {
  const operationPath = join6(lockPath, USAGE_LOCK_OPERATION_DIRECTORY);
  while (true) {
    const observed = await readUsageLockState(lockPath);
    if (!observed || observed.owner?.token !== token) return;
    if (!await claimUsageLockOperation(operationPath, timing)) {
      await delay(timing.retryMs);
      continue;
    }
    try {
      const current = await readUsageLockState(lockPath);
      if (!current || current.owner?.token !== token) return;
      const releasedPath = `${lockPath}.${token}.released`;
      try {
        await rename(lockPath, releasedPath);
      } catch (error) {
        if (error.code === "ENOENT") continue;
        throw error;
      }
      await rm(releasedPath, { recursive: true, force: true });
      return;
    } finally {
      await rm(operationPath, { recursive: true, force: true }).catch(() => void 0);
    }
  }
}
async function claimUsageLockOperation(operationPath, timing) {
  const owner = { token: randomUUID(), pid: process.pid };
  try {
    await mkdir4(operationPath);
    try {
      await writeOwner(operationPath, owner);
    } catch (error) {
      await rm(operationPath, { recursive: true, force: true }).catch(() => void 0);
      throw error;
    }
    return true;
  } catch (error) {
    if (error.code !== "EEXIST") {
      if (error.code === "ENOENT") return false;
      throw error;
    }
  }
  const observed = await readUsageLockState(operationPath);
  if (!observed || !isRecoverableUsageLock(observed, timing.staleMs)) return false;
  const abandonedPath = `${operationPath}.${randomUUID()}.stale`;
  try {
    await rename(operationPath, abandonedPath);
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
  await rm(abandonedPath, { recursive: true, force: true });
  return false;
}
async function writeOwner(path, owner) {
  await writeFile3(join6(path, USAGE_LOCK_OWNER_FILE), JSON.stringify(owner), {
    encoding: "utf8",
    flag: "wx"
  });
}
async function readUsageLockState(lockPath) {
  let lock;
  try {
    lock = await stat2(lockPath);
  } catch (error) {
    if (error.code === "ENOENT") return void 0;
    throw error;
  }
  try {
    const ownerPath = join6(lockPath, USAGE_LOCK_OWNER_FILE);
    const [raw, ownerFile] = await Promise.all([readFile4(ownerPath, "utf8"), stat2(ownerPath)]);
    return {
      owner: parseOwner(raw),
      mtimeMs: ownerFile.mtimeMs,
      dev: lock.dev,
      ino: lock.ino
    };
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return { mtimeMs: lock.mtimeMs, dev: lock.dev, ino: lock.ino };
  }
}
function parseOwner(raw) {
  try {
    const value = JSON.parse(raw);
    if (typeof value.token !== "string" || !value.token || !Number.isSafeInteger(value.pid) || value.pid <= 0) return void 0;
    return { token: value.token, pid: value.pid };
  } catch {
    return void 0;
  }
}
function isRecoverableUsageLock(lock, staleMs) {
  return Date.now() - lock.mtimeMs >= staleMs && !isProcessAlive(lock.owner?.pid);
}
function isProcessAlive(pid) {
  if (pid === void 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
}
function sameUsageLock(left, right) {
  return left.owner !== void 0 && right.owner !== void 0 ? left.owner.token === right.owner.token : left.owner === right.owner && left.dev === right.dev && left.ino === right.ino;
}
function resolveTiming(timing) {
  return {
    retryMs: timing.retryMs ?? 25,
    staleMs: timing.staleMs ?? 3e4,
    heartbeatMs: timing.heartbeatMs ?? 1e4
  };
}
function delay(ms) {
  return new Promise((resolve2) => setTimeout(resolve2, ms));
}

// src/usage-store.ts
var USAGE_DOCUMENT_VERSION = 1;
var UsageStore = class {
  usagePath;
  lifetime = zeroUsage();
  pendingUsage = zeroUsage();
  lastError;
  initialization;
  pendingWrite = Promise.resolve();
  constructor(agentDir) {
    this.usagePath = join7(agentDir, "shadow-minds", "usage.json");
  }
  initialize() {
    this.initialization ??= this.load();
    return this.initialization;
  }
  get current() {
    return {
      ...this.lifetime,
      cost: { ...this.lifetime.cost }
    };
  }
  get error() {
    return this.lastError;
  }
  add(usage) {
    this.lifetime = addUsage(this.lifetime, usage);
    this.pendingUsage = addUsage(this.pendingUsage, usage);
    return this.enqueueWrite();
  }
  async flush() {
    await this.pendingWrite;
    if (!isZeroUsage(this.pendingUsage)) await this.enqueueWrite();
  }
  enqueueWrite() {
    this.pendingWrite = this.pendingWrite.then(
      () => this.writePending(),
      () => this.writePending()
    ).then(
      () => {
        this.lastError = void 0;
      },
      (error) => {
        this.lastError = error instanceof Error ? error.message : String(error);
      }
    );
    return this.pendingWrite;
  }
  async load() {
    try {
      const raw = await readFile5(this.usagePath, "utf8");
      this.lifetime = parseUsageDocument(JSON.parse(raw)).lifetime;
      this.lastError = void 0;
    } catch (error) {
      if (error.code === "ENOENT") {
        this.lifetime = zeroUsage();
        this.lastError = void 0;
        return;
      }
      this.lifetime = zeroUsage();
      this.lastError = error instanceof Error ? error.message : String(error);
    }
  }
  async writePending() {
    const delta = this.pendingUsage;
    if (isZeroUsage(delta)) return;
    await mkdir5(dirname3(this.usagePath), { recursive: true });
    const releaseLock = await acquireUsageFileLock(this.usagePath);
    try {
      const committed = addUsage(await readUsageLifetime(this.usagePath), delta);
      await writeUsageDocument(this.usagePath, committed);
      this.pendingUsage = subtractUsage(this.pendingUsage, delta);
      this.lifetime = addUsage(committed, this.pendingUsage);
    } finally {
      await releaseLock();
    }
  }
};
function subtractUsage(left, right) {
  return {
    requests: left.requests - right.requests,
    input: left.input - right.input,
    output: left.output - right.output,
    cacheRead: left.cacheRead - right.cacheRead,
    cacheWrite: left.cacheWrite - right.cacheWrite,
    totalTokens: left.totalTokens - right.totalTokens,
    cost: {
      input: left.cost.input - right.cost.input,
      output: left.cost.output - right.cost.output,
      cacheRead: left.cost.cacheRead - right.cost.cacheRead,
      cacheWrite: left.cost.cacheWrite - right.cost.cacheWrite,
      total: left.cost.total - right.cost.total
    }
  };
}
function isZeroUsage(usage) {
  return usage.requests === 0 && usage.input === 0 && usage.output === 0 && usage.cacheRead === 0 && usage.cacheWrite === 0 && usage.totalTokens === 0 && usage.cost.input === 0 && usage.cost.output === 0 && usage.cost.cacheRead === 0 && usage.cost.cacheWrite === 0 && usage.cost.total === 0;
}
async function readUsageLifetime(usagePath) {
  try {
    const raw = await readFile5(usagePath, "utf8");
    return parseUsageDocument(JSON.parse(raw)).lifetime;
  } catch (error) {
    if (error.code === "ENOENT") return zeroUsage();
    throw error;
  }
}
async function writeUsageDocument(usagePath, lifetime) {
  const temporaryPath = `${usagePath}.${randomUUID2()}.tmp`;
  try {
    const document = { version: USAGE_DOCUMENT_VERSION, lifetime };
    await writeFile4(temporaryPath, `${JSON.stringify(document, null, 2)}
`, "utf8");
    await rename2(temporaryPath, usagePath);
  } finally {
    await rm2(temporaryPath, { force: true }).catch(() => void 0);
  }
}
function parseUsageDocument(input) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("usage must be a JSON object");
  }
  const value = input;
  if (value.version !== USAGE_DOCUMENT_VERSION) throw new Error("usage version is unsupported");
  return { version: USAGE_DOCUMENT_VERSION, lifetime: parseUsage(value.lifetime, "lifetime") };
}
function parseUsage(input, name) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new Error(`${name} must be an object`);
  }
  const value = input;
  const cost = value.cost;
  if (cost === null || typeof cost !== "object" || Array.isArray(cost)) {
    throw new Error(`${name}.cost must be an object`);
  }
  const costValue = cost;
  return {
    requests: nonNegativeInteger2(value.requests, `${name}.requests`),
    input: nonNegativeNumber(value.input, `${name}.input`),
    output: nonNegativeNumber(value.output, `${name}.output`),
    cacheRead: nonNegativeNumber(value.cacheRead, `${name}.cacheRead`),
    cacheWrite: nonNegativeNumber(value.cacheWrite, `${name}.cacheWrite`),
    totalTokens: nonNegativeNumber(value.totalTokens, `${name}.totalTokens`),
    cost: {
      input: nonNegativeNumber(costValue.input, `${name}.cost.input`),
      output: nonNegativeNumber(costValue.output, `${name}.cost.output`),
      cacheRead: nonNegativeNumber(costValue.cacheRead, `${name}.cost.cacheRead`),
      cacheWrite: nonNegativeNumber(costValue.cacheWrite, `${name}.cost.cacheWrite`),
      total: nonNegativeNumber(costValue.total, `${name}.cost.total`)
    }
  };
}
function nonNegativeNumber(value, name) {
  if (!isFiniteNumber(value) || value < 0) {
    throw new Error(`${name} must be a non-negative finite number`);
  }
  return value;
}
function nonNegativeInteger2(value, name) {
  const number = nonNegativeNumber(value, name);
  if (!Number.isSafeInteger(number)) throw new Error(`${name} must be a non-negative safe integer`);
  return number;
}

// src/runtime.ts
var SESSION_TEARDOWN_TIMEOUT_MS = 1e3;
var ShadowMindRuntime = class {
  constructor(pi) {
    this.pi = pi;
    this.batcher = new ReportBatcher(
      this.configStore.current.resultBatchWindowMs,
      (reports) => {
        this.completionReview.invalidate();
        void this.deliverReports(reports);
      }
    );
  }
  agentDir = getAgentDir();
  configStore = new ConfigStore(this.agentDir);
  registry = new ShadowRegistry(this.agentDir);
  entityStore = new EntityStore(
    this.registry,
    this.configStore.configPath
  );
  runner = new ShadowRunner();
  usageStore = new UsageStore(this.agentDir);
  active = /* @__PURE__ */ new Map();
  finalResponseBudget = new FinalResponseBudget();
  completionReview = new CompletionReview({
    currentEpoch: () => this.epoch,
    maxParallel: () => this.configStore.current.maxParallelShadows,
    activeCount: () => this.active.size,
    activeShadowIds: () => new Set([...this.active.values()].map(({ shadow }) => shadow.id)),
    canLaunch: () => !this.batcher.hasPending,
    launch: (pending, review) => this.launchShadow({ ...pending, completionReview: review }),
    deliver: (reports) => void this.deliverReports(reports),
    onReviewCompleted: (shadowIds) => this.finalResponseBudget.commit(shadowIds)
  });
  recentEvents = [];
  recentRuns = [];
  reports = new ReportBrowser();
  batcher;
  sessionLifetime = new SessionLifetime();
  epoch = 0;
  modelCalls = 0;
  paused = false;
  panelVisible = false;
  latestContext;
  diagnostics = [];
  sessionUsage = zeroUsage();
  shadowCount = 0;
  completedWithFinalText = false;
  random = Math.random;
  register() {
    registerManagementTools(
      this.pi,
      this.entityStore,
      () => this.configStore.current
    );
    this.registerEvents();
    this.registerUi();
  }
  registerEvents() {
    this.pi.on("session_start", async (_event, ctx) => {
      this.sessionLifetime.activate();
      this.latestContext = ctx;
      this.modelCalls = 0;
      this.completedWithFinalText = false;
      this.finalResponseBudget.reset();
      this.sessionUsage = zeroUsage();
      this.recentRuns.length = 0;
      this.reports.reset();
      await this.configStore.initialize();
      await this.usageStore.initialize();
      this.random = createRandom(this.configStore.current.randomSeed);
      await this.registry.initialize();
      await this.refresh(ctx);
      this.record("session-config", {
        randomSeed: this.configStore.current.randomSeed ?? "random"
      });
      this.updateStatus(ctx);
    });
    this.pi.on("input", (event, ctx) => {
      this.latestContext = ctx;
      if (event.source === "extension") return;
      this.completedWithFinalText = false;
      this.finalResponseBudget.reset();
      this.epoch += 1;
      this.abortAll("new-user-input");
    });
    this.pi.on("after_provider_response", (_event, ctx) => {
      this.latestContext = ctx;
      this.modelCalls += 1;
    });
    this.pi.on("turn_end", async (event, ctx) => {
      this.latestContext = ctx;
      const toolResults = event.toolResults ?? [];
      const executedTools = extractToolNames(toolResults);
      if (executedTools.size === 0) {
        this.record("heartbeat-skipped", {
          reason: "no-tool-activity",
          modelCalls: this.modelCalls
        });
        return;
      }
      await this.onHeartbeat(ctx, executedTools);
    });
    this.pi.on("agent_end", (event, ctx) => {
      this.latestContext = ctx;
      this.completedWithFinalText = shouldEvaluateFinalResponse(event.messages);
    });
    this.pi.on("agent_settled", async (_event, ctx) => {
      this.latestContext = ctx;
      if (!this.completedWithFinalText) {
        this.record("final-response-skipped", {
          reason: "no-final-assistant-text"
        });
        return;
      }
      this.completedWithFinalText = false;
      await this.onFinalResponse(ctx);
    });
    this.pi.on("session_shutdown", async (event, ctx) => {
      this.latestContext = ctx;
      if (event.reason === "quit" && (ctx.mode === "print" || ctx.mode === "json")) {
        await this.drainHeadless(ctx);
      }
      this.epoch += 1;
      this.abortAll("session-shutdown");
      if (this.active.size > 0) {
        const result = await waitForSettled({
          timeoutMs: SESSION_TEARDOWN_TIMEOUT_MS,
          isSettled: () => this.active.size === 0
        });
        if (!result.settled) this.active.clear();
      }
      await this.usageStore.flush();
      this.reports.reset();
      ctx.ui.setStatus("shadow-mind", void 0);
      ctx.ui.setWidget("shadow-mind-panel", void 0);
      this.sessionLifetime.deactivate();
    });
  }
  registerUi() {
    this.pi.registerCommand("shadow", {
      description: "Show Shadow Mind status, or toggle/pause/resume it",
      handler: async (args, ctx) => {
        this.latestContext = ctx;
        const command = args.trim().toLowerCase();
        if (command === "pause") {
          this.setPaused(true, ctx);
          return;
        }
        if (command === "resume") {
          this.setPaused(false, ctx);
          return;
        }
        if (command === "toggle") {
          this.setPaused(!this.paused, ctx);
          return;
        }
        if (await this.reports.handleCommand(command, ctx)) return;
        if (command === "status") {
          await this.refresh(ctx);
          ctx.ui.notify(
            this.statusLines().join("\n"),
            this.diagnostics.length ? "warning" : "info"
          );
        } else if (command === "hide") {
          this.panelVisible = false;
          ctx.ui.setWidget("shadow-mind-panel", void 0);
        } else {
          await this.refresh(ctx);
          this.panelVisible = !this.panelVisible;
        }
        this.updateStatus(ctx);
      }
    });
    for (const shortcut of ["f6", "alt+s"]) {
      this.pi.registerShortcut(shortcut, {
        description: "Pause or resume Shadow Mind",
        handler: (ctx) => {
          this.latestContext = ctx;
          this.setPaused(!this.paused, ctx);
        }
      });
    }
    this.pi.registerMessageRenderer(
      "shadow-report",
      (message, _options, theme) => {
        const content = typeof message.content === "string" ? message.content : "Shadow report";
        const prefix = theme.fg("accent", "\u{1F419} shadow \xB7 ");
        return new Text2(`${prefix}${content}`, 0, 0);
      }
    );
  }
  async onHeartbeat(ctx, executedTools) {
    const snapshot = await this.refresh(ctx);
    const config = this.configStore.current;
    if (!shouldEvaluateHeartbeat(executedTools, config.heartbeatTools)) {
      this.record("heartbeat-skipped", {
        reason: "tool-filtered",
        modelCalls: this.modelCalls
      });
      return;
    }
    if (this.paused || !ctx.model) {
      this.record("heartbeat-skipped", {
        reason: this.paused ? "paused" : "no-model",
        modelCalls: this.modelCalls
      });
      return;
    }
    const fullModelId = `${ctx.model.provider}/${ctx.model.id}`;
    const decision = decideHeartbeat({
      heartbeatProbability: config.heartbeatProbability,
      availableSlots: Math.max(0, config.maxParallelShadows - this.active.size),
      shadows: snapshot.shadows,
      activeShadowIds: new Set(
        [...this.active.values()].map(({ shadow }) => shadow.id)
      ),
      mainModelId: fullModelId,
      random: this.random,
      executedTools
    });
    this.record("heartbeat", {
      modelCalls: this.modelCalls,
      roll: decision.heartbeatRoll,
      candidates: decision.candidates,
      activated: decision.activated.map(({ shadow, roll }) => ({
        id: shadow.id,
        roll
      })),
      ...decision.modelFiltered.length ? { modelFiltered: decision.modelFiltered } : {},
      ...decision.runningExcluded.length ? { runningExcluded: decision.runningExcluded } : {},
      ...decision.toolFiltered.length ? { toolFiltered: decision.toolFiltered } : {}
    });
    if (!decision.activated.length) return;
    const context = buildShadowSessionContext(
      ctx.sessionManager.getEntries(),
      ctx.sessionManager.getLeafId(),
      ctx.sessionManager.getSessionFile()
    );
    const availableTools = new Set(
      this.pi.getAllTools().map((tool2) => tool2.name)
    );
    for (const { shadow } of decision.activated) {
      this.launchShadow({
        ctx,
        shadow,
        mainModel: ctx.model,
        fullModelId,
        context,
        availableTools
      });
    }
  }
  async onFinalResponse(ctx) {
    if (this.batcher.hasPending) {
      await this.batcher.flush();
      return;
    }
    const request = this.completionReview.begin(this.epoch);
    const snapshot = await this.refresh(ctx);
    if (!this.completionReview.isCurrent(request)) {
      this.record("final-response-skipped", { reason: "superseded" });
      return;
    }
    if (this.paused || !ctx.model) {
      this.completionReview.cancel(request);
      this.record("final-response-skipped", {
        reason: this.paused ? "paused" : "no-model"
      });
      return;
    }
    const mainModel = ctx.model;
    const fullModelId = `${mainModel.provider}/${mainModel.id}`;
    const decision = decideFinalResponse({
      shadows: snapshot.shadows,
      mainModelId: fullModelId,
      canRunFinalResponse: (shadow) => this.finalResponseBudget.canRun(shadow)
    });
    this.record("final-response", {
      candidates: decision.candidates,
      activated: decision.activated.map(({ shadow }) => shadow.id),
      ...decision.modelFiltered.length ? { modelFiltered: decision.modelFiltered } : {},
      ...decision.runningExcluded.length ? { runningExcluded: decision.runningExcluded } : {},
      ...decision.roundFiltered.length ? { roundFiltered: decision.roundFiltered } : {}
    });
    if (!decision.activated.length) {
      this.completionReview.schedule(request, []);
      return;
    }
    const context = buildShadowSessionContext(
      ctx.sessionManager.getEntries(),
      ctx.sessionManager.getLeafId(),
      ctx.sessionManager.getSessionFile()
    );
    const availableTools = new Set(
      this.pi.getAllTools().map((tool2) => tool2.name)
    );
    this.completionReview.schedule(
      request,
      decision.activated.map(({ shadow }) => ({
        epoch: request.epoch,
        shadowId: shadow.id,
        ctx,
        shadow,
        mainModel,
        fullModelId,
        context,
        availableTools
      }))
    );
  }
  launchShadow(options) {
    const {
      ctx,
      shadow,
      mainModel,
      fullModelId,
      context,
      availableTools,
      completionReview
    } = options;
    const runId = randomUUID3();
    const runEpoch = options.epoch ?? this.epoch;
    const { tools, missing } = resolveShadowTools(shadow.tools, availableTools);
    const activeRun = { shadow, epoch: runEpoch };
    if (completionReview) activeRun.completionReview = completionReview;
    this.active.set(runId, activeRun);
    this.record("run-start", {
      runId,
      shadowId: shadow.id,
      model: shadow.runWithModel ?? this.configStore.current.defaultShadowModel ?? fullModelId,
      ...missing.length ? { missingTools: missing } : {}
    });
    this.updateStatus(ctx);
    void this.runner.run({
      shadow: structuredClone(shadow),
      config: structuredClone(this.configStore.current),
      epoch: runEpoch,
      runId,
      cwd: ctx.cwd,
      agentDir: this.agentDir,
      mainSystemPrompt: ctx.getSystemPrompt(),
      // SAFETY: buildSessionContext returns Pi messages; ShadowRunner treats them as read-only records.
      messages: context.messages,
      mainModel,
      tools,
      resolveModel: (id) => resolveModel(ctx, id),
      modelAuthOk: (model) => ctx.modelRegistry.hasConfiguredAuth(model) || ctx.modelRegistry.isUsingOAuth(model),
      mainThinkingLevel: ctx.thinkingLevel,
      onReport: (report) => {
        if (completionReview) completionReview.accept(report);
        else this.acceptReport(report);
      }
    }).then((result) => this.handleRunEnd(runId, shadow, result)).catch((error) => {
      const activeRun2 = this.active.get(runId);
      this.active.delete(runId);
      this.completionReview.slotAvailable();
      this.completionReview.complete(activeRun2?.completionReview);
      this.record("run-end", {
        runId,
        shadowId: shadow.id,
        reason: "error",
        error: error instanceof Error ? error.message : String(error)
      });
    });
  }
  handleRunEnd(runId, shadow, result) {
    const activeRun = this.active.get(runId);
    this.active.delete(runId);
    this.completionReview.slotAvailable();
    const persisted = this.usageStore.add(result.usage);
    if (activeRun?.epoch !== this.epoch) {
      this.completionReview.complete(activeRun?.completionReview);
      return;
    }
    this.sessionUsage = addUsage(this.sessionUsage, result.usage);
    this.recentRuns.push({
      shadowName: shadow.name,
      completedAt: (/* @__PURE__ */ new Date()).toISOString(),
      result
    });
    if (this.recentRuns.length > 5) this.recentRuns.shift();
    this.record("run-end", { runId, shadowId: shadow.id, ...result });
    if (this.latestContext && this.sessionLifetime.isActive)
      this.updateStatus(this.latestContext);
    this.completionReview.complete(activeRun.completionReview);
    void persisted.then(() => {
      if (this.latestContext && this.sessionLifetime.isActive)
        this.updateStatus(this.latestContext);
    });
  }
  acceptReport(report) {
    if (report.epoch !== this.epoch) return;
    this.batcher.add(report);
  }
  async deliverReports(reports) {
    const current = reports.filter((report) => report.epoch === this.epoch);
    if (!current.length) return;
    const content = formatReportBatch(current);
    this.record("report-delivered", {
      runIds: current.map((report) => report.runId),
      count: current.length
    });
    const idle = this.latestContext?.isIdle() ?? true;
    const delivered = this.sessionLifetime.run(() => {
      this.pi.sendMessage(
        {
          customType: "shadow-report",
          content,
          display: true,
          details: {
            reports: current.map(({ shadowId, runId }) => ({
              shadowId,
              runId
            }))
          }
        },
        { triggerTurn: true, deliverAs: idle ? "followUp" : "steer" }
      );
    });
    if (delivered) this.reports.add(current);
  }
  async refresh(ctx) {
    const config = await this.configStore.reload();
    const registry = await this.registry.load();
    this.batcher.setWindow(config.config.resultBatchWindowMs);
    this.shadowCount = registry.shadows.length;
    this.diagnostics = [
      ...config.error ? [`config: ${config.error}`] : [],
      ...registry.diagnostics.map(
        (item) => `${item.filePath}: ${item.message}`
      )
    ];
    this.updateStatus(ctx);
    return registry;
  }
  abortAll(reason) {
    this.runner.abortAll();
    this.completionReview.invalidate();
    this.batcher.clear();
    this.record("runs-aborted", { reason, count: this.active.size });
  }
  async drainHeadless(ctx) {
    if (this.active.size === 0 && !this.batcher.hasPending) return;
    const timeoutMs = this.configStore.current.headlessDrainTimeoutSeconds * 1e3;
    this.record("headless-drain-start", {
      timeoutMs,
      active: this.active.size
    });
    const result = await waitForSettled({
      timeoutMs,
      isSettled: () => this.active.size === 0 && !this.batcher.hasPending && ctx.isIdle() && !ctx.hasPendingMessages()
    });
    this.record(
      result.settled ? "headless-drain-complete" : "headless-drain-timeout",
      {
        durationMs: result.durationMs,
        active: this.active.size
      }
    );
    if (!result.settled) this.abortAll("headless-drain-timeout");
  }
  record(kind, data) {
    const event = {
      at: (/* @__PURE__ */ new Date()).toISOString(),
      kind,
      epoch: this.epoch,
      data
    };
    this.recentEvents.push(event);
    if (this.recentEvents.length > 20) this.recentEvents.shift();
    this.sessionLifetime.run(
      () => this.pi.appendEntry("shadow-mind-event", event)
    );
  }
  setPaused(paused, ctx) {
    this.paused = paused;
    if (paused) this.abortAll("paused");
    ctx.ui.notify(
      paused ? "Shadow Mind paused" : "Shadow Mind resumed",
      "info"
    );
    this.updateStatus(ctx);
  }
  updateStatus(ctx) {
    this.sessionLifetime.run(() => {
      const diagnostics = this.usageStore.error ? [...this.diagnostics, `usage: ${this.usageStore.error}`] : this.diagnostics;
      const warning = diagnostics.length || this.hasRecentRunErrors() ? " !" : "";
      const usage = `${formatUsageTokens(this.sessionUsage.totalTokens)} \xB7 ${formatUsageCost(this.sessionUsage.cost.total)}`;
      ctx.ui.setStatus(
        "shadow-mind",
        this.paused ? `\u{1F419} Paused \xB7 ${usage}${warning}` : `\u{1F419} ${this.active.size} \xB7 ${usage}${warning}`
      );
      if (this.panelVisible)
        ctx.ui.setWidget("shadow-mind-panel", this.statusLines(), {
          placement: "aboveEditor"
        });
    });
  }
  hasRecentRunErrors() {
    return this.recentEvents.slice(-3).some(
      (event) => event.kind === "run-end" && (event.data?.reason === "error" || event.data?.reason === "timeout")
    );
  }
  statusLines() {
    const config = this.configStore.current;
    const diagnostics = this.usageStore.error ? [...this.diagnostics, `usage: ${this.usageStore.error}`] : this.diagnostics;
    return [
      `\u{1F419} Shadow Mind \xB7 ${this.paused ? "paused" : "active"} \xB7 running ${this.active.size}/${config.maxParallelShadows}`,
      `heartbeat ${formatNumber(config.heartbeatProbability)} \xB7 batch ${config.resultBatchWindowMs}ms \xB7 timeout ${config.defaultShadowTimeoutSeconds}s \xB7 drain ${config.headlessDrainTimeoutSeconds}s \xB7 thinking ${config.defaultThinkingLevel}`,
      `definitions: ${this.shadowCount} valid \xB7 ${this.diagnostics.length} invalid`,
      formatUsageDetail("session", this.sessionUsage),
      `usage lifetime \xB7 ${formatUsageSummary(this.usageStore.current)}`,
      ...this.recentRuns.slice(-3).map(
        ({ shadowName, completedAt, result }) => `recent run \xB7 ${formatCompletedAt(completedAt)} \xB7 ${shadowName} \xB7 ${result.reason} \xB7 ${formatUsageSummary(result.usage)}`
      ),
      ...diagnostics.map((diagnostic) => `diagnostic: ${diagnostic}`),
      ...this.recentEvents.slice(-5).map((event) => {
        const failed = event.kind === "run-end" && (event.data?.reason === "error" || event.data?.reason === "timeout");
        const detail = failed ? ` ${event.data?.error ?? event.data?.reason}` : "";
        return `${new Date(event.at).toLocaleTimeString("en-GB", { hour12: false })} ${event.kind}${detail}`;
      }),
      "Shortcut: Alt+S toggle \xB7 Commands: /shadow toggle | pause | resume | status | hide | reports"
    ];
  }
};
function resolveModel(ctx, fullId) {
  const separator = fullId.indexOf("/");
  if (separator <= 0 || separator === fullId.length - 1) return void 0;
  return ctx.modelRegistry.find(
    fullId.slice(0, separator),
    fullId.slice(separator + 1)
  );
}
function formatNumber(value) {
  return Number(value.toFixed(3)).toString();
}
function formatCompletedAt(completedAt) {
  return new Date(completedAt).toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  });
}

// src/index.ts
function shadowMindExtension(pi) {
  new ShadowMindRuntime(pi).register();
}
export {
  shadowMindExtension as default
};
//# sourceMappingURL=index.js.map
