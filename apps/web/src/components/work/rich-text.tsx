/** Texto rico: editor TipTap preguiçoso + renderização leve (sem carregar o TipTap) para leitura. */
import type { RichTextDoc } from "@recpm/shared";
import { Skeleton } from "@recpm/ui";
import { Fragment, lazy, type ReactNode, Suspense } from "react";

const Editor = lazy(() => import("./rich-text-editor"));

export function RichTextInput(props: {
  value: RichTextDoc | null;
  onChange: (doc: RichTextDoc) => void;
  placeholder?: string;
  label: string;
  autoFocus?: boolean;
}) {
  return (
    <Suspense fallback={<Skeleton className="h-32" />}>
      <Editor {...props} />
    </Suspense>
  );
}

type Node = {
  type?: string;
  text?: string;
  content?: Node[];
  marks?: { type: string; attrs?: { href?: string } }[];
  attrs?: { level?: number };
};

function render(n: Node, key: number): ReactNode {
  const kids = n.content?.map(render);
  switch (n.type) {
    case "doc":
      return <Fragment key={key}>{kids}</Fragment>;
    case "paragraph":
      return <p key={key}>{kids?.length ? kids : <br />}</p>;
    case "heading":
      return n.attrs?.level === 2 ? <h2 key={key}>{kids}</h2> : <h3 key={key}>{kids}</h3>;
    case "bulletList":
      return <ul key={key}>{kids}</ul>;
    case "orderedList":
      return <ol key={key}>{kids}</ol>;
    case "listItem":
      return <li key={key}>{kids}</li>;
    case "blockquote":
      return <blockquote key={key}>{kids}</blockquote>;
    case "codeBlock":
      return <pre key={key}>{kids}</pre>;
    case "hardBreak":
      return <br key={key} />;
    case "text": {
      let el: ReactNode = n.text;
      for (const m of n.marks ?? []) {
        if (m.type === "bold") el = <strong>{el}</strong>;
        else if (m.type === "italic") el = <em>{el}</em>;
        else if (m.type === "strike") el = <s>{el}</s>;
        else if (m.type === "code") el = <code>{el}</code>;
        else if (m.type === "link" && m.attrs?.href?.startsWith("http"))
          el = (
            <a
              href={m.attrs.href}
              target="_blank"
              rel="noreferrer noopener"
              className="text-primary underline"
            >
              {el}
            </a>
          );
      }
      return <Fragment key={key}>{el}</Fragment>;
    }
    default:
      return kids ? <Fragment key={key}>{kids}</Fragment> : null;
  }
}

export function RichTextView({ doc, className }: { doc: unknown; className?: string }) {
  if (!doc || typeof doc !== "object") return null;
  return <div className={`rich-text text-sm ${className ?? ""}`}>{render(doc as Node, 0)}</div>;
}

export const isEmptyDoc = (doc: RichTextDoc | null | undefined) =>
  !doc?.content?.some((n) => JSON.stringify(n).includes('"text"'));
