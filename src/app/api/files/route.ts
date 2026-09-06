import { getBucket } from "@/lib/cf";

export const runtime = "edge";
export const dynamic = "force-dynamic";

type FileItem = {
  name: string;
  key?: string;
  type: string;
  size?: number;
  lastModified: string;
  children?: FileItem[];
};

type InternalNode =
  | {
      kind: "folder";
      name: string;
      children: Map<string, InternalNode>;
      lastModifiedMs: number;
    }
  | {
      kind: "file";
      name: string;
      key: string;
      size?: number;
      lastModifiedMs: number;
      mime: string;
    };

const guessMime = (key: string) => {
  const ext = key.split(".").pop()?.toLowerCase() ?? "";
  switch (ext) {
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "png":
      return "image/png";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    case "svg":
      return "image/svg+xml";
    case "mp4":
      return "video/mp4";
    case "mov":
      return "video/quicktime";
    case "mkv":
      return "video/x-matroska";
    case "mp3":
      return "audio/mpeg";
    case "wav":
      return "audio/wav";
    case "pdf":
      return "application/pdf";
    case "txt":
      return "text/plain";
    case "md":
      return "text/markdown";
    case "json":
      return "application/json";
    case "zip":
      return "application/zip";
    case "7z":
      return "application/x-7z-compressed";
    case "rar":
      return "application/vnd.rar";
    case "tar":
      return "application/x-tar";
    case "gz":
      return "application/gzip";
    case "doc":
      return "application/msword";
    case "docx":
      return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    case "xls":
      return "application/vnd.ms-excel";
    case "xlsx":
      return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    case "ppt":
      return "application/vnd.ms-powerpoint";
    case "pptx":
      return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
    default:
      return "application/octet-stream";
  }
};

const buildTree = (objects: Array<{ key: string; size?: number; uploaded?: Date }>): FileItem[] => {
  const root: InternalNode = { kind: "folder", name: "", children: new Map(), lastModifiedMs: 0 };

  const ensureFolder = (parent: Extract<InternalNode, { kind: "folder" }>, name: string) => {
    const existing = parent.children.get(name);
    if (existing?.kind === "folder") return existing;
    const created: InternalNode = { kind: "folder", name, children: new Map(), lastModifiedMs: 0 };
    parent.children.set(name, created);
    return created;
  };

  for (const obj of objects) {
    if (!obj?.key) continue;
    const parts = obj.key.split("/").filter((p) => p.length > 0);
    if (parts.length === 0) continue;

    let folder = root as Extract<InternalNode, { kind: "folder" }>;
    for (let i = 0; i < parts.length - 1; i++) {
      folder = ensureFolder(folder, parts[i]);
    }

    const name = parts[parts.length - 1];
    if (obj.key.endsWith('/')) {
      ensureFolder(folder, name);
      continue;
    }
    const lastModifiedMs = obj.uploaded ? obj.uploaded.getTime() : Date.now();
    const node: InternalNode = {
      kind: "file",
      name,
      key: obj.key,
      size: obj.size,
      lastModifiedMs,
      mime: guessMime(obj.key),
    };
    folder.children.set(name, node);
  }

  const materialize = (node: InternalNode): FileItem => {
    if (node.kind === "file") {
      return {
        name: node.name,
        key: node.key,
        type: node.mime,
        size: node.size,
        lastModified: new Date(node.lastModifiedMs).toISOString(),
      };
    }

    const children = Array.from(node.children.values()).map(materialize);
    children.sort((a, b) => {
      const at = a.type === "folder" ? 0 : 1;
      const bt = b.type === "folder" ? 0 : 1;
      if (at !== bt) return at - bt;
      return a.name.localeCompare(b.name, "zh-CN", { sensitivity: "base" });
    });

    const lastModifiedMs =
      children.length === 0
        ? Date.now()
        : Math.max(...children.map((c) => new Date(c.lastModified).getTime()).filter((t) => Number.isFinite(t)));

    return {
      name: node.name,
      type: "folder",
      lastModified: new Date(lastModifiedMs).toISOString(),
      children,
    };
  };

  const rootFolder = root as Extract<InternalNode, { kind: "folder" }>;
  return Array.from(rootFolder.children.values()).map(materialize);
};

export async function GET() {
  try {
    const bucket = getBucket();

    const objects: Array<{ key: string; size?: number; uploaded?: Date }> = [];
    let cursor: string | undefined = undefined;

    for (;;) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const page: any = await bucket.list({ cursor, limit: 1000 });
      if (Array.isArray(page?.objects)) {
        objects.push(...page.objects);
      }
      if (!page?.truncated) break;
      cursor = page?.cursor;
      if (!cursor) break;
    }

    const tree = buildTree(objects);

    return Response.json(tree, {
      headers: {
        "Cache-Control": "no-store",
      },
    });
  } catch (error: unknown) {
    const status = typeof (error as { status?: unknown })?.status === "number" ? (error as { status: number }).status : 500;
    const message = error instanceof Error ? error.message : String(error);
    return new Response(JSON.stringify({ error: message }), {
      status,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  }
}
