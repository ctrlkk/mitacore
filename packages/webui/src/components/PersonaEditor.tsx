import Editor, { loader, type OnMount } from "@monaco-editor/react";
import { useTheme } from "next-themes";
import { useEffect, useRef, useState } from "react";
import * as monaco from "monaco-editor/editor/editor.api";
import "monaco-editor/languages/definitions/markdown/register";
import EditorWorker from "monaco-editor/editor/editor.worker?worker";

globalThis.MonacoEnvironment = {
  getWorker() {
    return new EditorWorker();
  },
};

loader.config({ monaco });

type PersonaEditorProps = {
  value: string;
  onChange: (value: string) => void;
  onSave: () => void;
};

export function PersonaEditor({ value, onChange, onSave }: PersonaEditorProps) {
  const { resolvedTheme } = useTheme();
  const saveRef = useRef(onSave);
  const editorRef = useRef<Parameters<OnMount>[0] | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    saveRef.current = onSave;
  }, [onSave]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let frame = 0;
    const layout = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const { width, height } = container.getBoundingClientRect();
        const nextSize = { width: Math.floor(width), height: Math.floor(height) };

        setSize((currentSize) =>
          currentSize.width === nextSize.width && currentSize.height === nextSize.height ? currentSize : nextSize,
        );
        editorRef.current?.layout(nextSize);
      });
    };
    const observer = new ResizeObserver(layout);

    observer.observe(container);
    layout();
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, []);

  const handleMount: OnMount = (editor, monacoInstance) => {
    editorRef.current = editor;
    editor.addCommand(monacoInstance.KeyMod.CtrlCmd | monacoInstance.KeyCode.KeyS, () => saveRef.current());
    requestAnimationFrame(() => editor.layout());
  };

  return (
    <div ref={containerRef} className="min-h-0 flex-1">
      <Editor
        height={size.height}
        width={size.width}
        language="markdown"
        path="inmemory://persona/role.md"
        theme={resolvedTheme === "dark" ? "vs-dark" : "vs"}
        value={value}
        onChange={(nextValue) => onChange(nextValue ?? "")}
        onMount={handleMount}
        options={{
          automaticLayout: true,
          wordWrap: "on",
          wrappingIndent: "same",
          fontFamily: '"DM Mono", "Noto Sans SC", monospace',
          fontSize: 13,
          lineHeight: 24,
          lineNumbersMinChars: 3,
          minimap: { enabled: true, maxColumn: 80, renderCharacters: false },
          padding: { top: 14, bottom: 14 },
          renderLineHighlight: "line",
          scrollBeyondLastLine: false,
          smoothScrolling: false,
        }}
      />
    </div>
  );
}
