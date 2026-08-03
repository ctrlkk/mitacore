import { AutoComplete } from "antd";
import { useState } from "react";

type ModelPickerProps = {
  value: string;
  options: string[];
  onChange: (value: string) => void;
  onSelect?: (value: string) => void;
};

export function ModelPicker({ value, options, onChange, onSelect }: ModelPickerProps) {
  const [open, setOpen] = useState(false);

  return (
    <AutoComplete
      className="model-autocomplete"
      value={value}
      open={open}
      options={options.map((option) => ({ value: option }))}
      placeholder="输入或选择模型 ID"
      notFoundContent="请先自动获取模型，或直接输入模型 ID"
      onChange={(nextValue) => {
        onChange(nextValue);
        setOpen(true);
      }}
      onFocus={() => setOpen(true)}
      onClick={() => setOpen(true)}
      onOpenChange={setOpen}
      onSelect={(selectedValue) => {
        onSelect?.(selectedValue);
        setOpen(false);
      }}
      filterOption={(input, option) => option?.value.toLowerCase().includes(input.toLowerCase()) ?? false}
    />
  );
}
