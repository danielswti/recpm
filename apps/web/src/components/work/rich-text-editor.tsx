/** Editor TipTap (carregado sob demanda: só baixa quando alguém vai editar). */
import type { RichTextDoc } from "@recpm/shared";
import { cn } from "@recpm/ui";
import { EditorContent, type JSONContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { Bold, Italic, List, ListOrdered } from "lucide-react";
import { useEffect } from "react";

export default function RichTextEditor({
  value,
  onChange,
  placeholder,
  label,
  autoFocus,
}: {
  value: RichTextDoc | null;
  onChange: (doc: RichTextDoc) => void;
  placeholder?: string;
  label: string;
  autoFocus?: boolean;
}) {
  const editor = useEditor({
    extensions: [StarterKit.configure({ heading: { levels: [2, 3] } })],
    content: (value as JSONContent | null) ?? "",
    immediatelyRender: false,
    autofocus: autoFocus ? "end" : false,
    editorProps: {
      attributes: {
        "aria-label": label,
        "data-placeholder": placeholder ?? "",
        class: "rich-text min-h-24 px-3 py-2 text-sm focus:outline-none",
      },
    },
    onUpdate: ({ editor: e }) => onChange(e.getJSON() as RichTextDoc),
  });
  // valor externo trocado (outra tarefa aberta)
  useEffect(() => {
    if (editor && value && JSON.stringify(editor.getJSON()) !== JSON.stringify(value))
      editor.commands.setContent(value as JSONContent);
  }, [editor, value]);

  const btn = (active: boolean) =>
    cn("rounded p-1.5 hover:bg-accent", active && "bg-accent text-accent-foreground");
  return (
    <div className="rounded-md border border-input focus-within:ring-2 focus-within:ring-ring/40">
      <div className="flex gap-0.5 border-b px-1 py-1" role="toolbar" aria-label={label}>
        <button
          type="button"
          aria-label="Negrito"
          className={btn(!!editor?.isActive("bold"))}
          onClick={() => editor?.chain().focus().toggleBold().run()}
        >
          <Bold className="size-4" />
        </button>
        <button
          type="button"
          aria-label="Itálico"
          className={btn(!!editor?.isActive("italic"))}
          onClick={() => editor?.chain().focus().toggleItalic().run()}
        >
          <Italic className="size-4" />
        </button>
        <button
          type="button"
          aria-label="Lista"
          className={btn(!!editor?.isActive("bulletList"))}
          onClick={() => editor?.chain().focus().toggleBulletList().run()}
        >
          <List className="size-4" />
        </button>
        <button
          type="button"
          aria-label="Lista numerada"
          className={btn(!!editor?.isActive("orderedList"))}
          onClick={() => editor?.chain().focus().toggleOrderedList().run()}
        >
          <ListOrdered className="size-4" />
        </button>
      </div>
      <EditorContent editor={editor} />
    </div>
  );
}
