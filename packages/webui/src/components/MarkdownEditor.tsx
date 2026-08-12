import Editor, { loader, type OnMount } from "@monaco-editor/react";
import * as monaco from "../../node_modules/monaco-editor/esm/vs/editor/editor.api.js";
import "../../node_modules/monaco-editor/esm/vs/languages/definitions/markdown/register.js";
import EditorWorker from "../../node_modules/monaco-editor/esm/vs/editor/editor.worker.js?worker";
import { LoaderCircle } from "lucide-react";
import { useEffect, useRef } from "react";

globalThis.MonacoEnvironment = {
  getWorker() {
    return new EditorWorker();
  },
};
loader.config({ monaco });

type MarkdownEditorProps = {
  value: string;
  path: string;
  height: string;
  disabled?: boolean;
  onChange: (value: string) => void;
  onSave?: () => void;
};

export function MarkdownEditor({ value, path, height, disabled, onChange, onSave }: MarkdownEditorProps) {
  const saveRef = useRef(onSave);

  useEffect(() => {
    saveRef.current = onSave;
  }, [onSave]);

  const handleMount: OnMount = (editor, monacoInstance) => {
    editor.addCommand(monacoInstance.KeyMod.CtrlCmd | monacoInstance.KeyCode.KeyS, () => saveRef.current?.());
  };

  return (
    <Editor
      height={height}
      language="markdown"
      path={`file:///${path || "untitled.md"}`}
      value={value}
      onChange={(nextValue) => onChange(nextValue ?? "")}
      onMount={handleMount}
      loading={
        <p className="flex h-full items-center justify-center gap-2 bg-[#fbfcfd] text-xs text-muted">
          <LoaderCircle className="animate-spin" size={16} />
          正在加载 VS Code 编辑器…
        </p>
      }
      options={{
        automaticLayout: true,
        readOnly: disabled,
        readOnlyMessage: { value: "请先选择一篇笔记。" },
        wordWrap: "on",
        wrappingIndent: "same",
        lineNumbersMinChars: 3,
        minimap: { enabled: true, maxColumn: 80, renderCharacters: false },
        fontFamily: '"DM Mono", "Noto Sans SC", monospace',
        fontSize: 13,
        lineHeight: 24,
        padding: { top: 14, bottom: 14 },
        renderLineHighlight: "line",
        scrollBeyondLastLine: false,
        smoothScrolling: true,
        cursorSmoothCaretAnimation: "on",
        bracketPairColorization: { enabled: true },
        guides: { bracketPairs: true, indentation: true },
        overviewRulerBorder: false,
        fixedOverflowWidgets: true,
      }}
    />
  );
}
