import React from "react";
import {
  File,
  FileArchive,
  FileAudio,
  FileCode,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileVideo,
  X,
  type LucideIcon,
} from "lucide-react";
import type { AttachedFile } from "../hooks/useAgentLoop";
import "./Attachments.css";

/**
 * 첨부 파일 표시 — 채팅 말풍선과 입력창이 같은 모양을 쓴다.
 *
 * 이미지는 이름만 보여줘도 무엇인지 알 수 없다. 첨부한 사람도 모델도 그림을 보고
 * 말하므로 대화에도 그림이 남아야 한다. 이미지가 아닌 파일은 종류를 알려주는
 * 아이콘과 크기를 붙인 카드로 보여준다.
 */

const ICON_BY_EXT: Array<[RegExp, LucideIcon]> = [
  [/^(txt|md|markdown|rtf|log)$/, FileText],
  [/^(ts|tsx|js|jsx|py|rs|go|java|c|h|cpp|swift|sh|zsh|json|toml|yaml|yml|html|css|sql)$/, FileCode],
  [/^(csv|tsv|xls|xlsx|numbers)$/, FileSpreadsheet],
  [/^(zip|tar|gz|tgz|rar|7z)$/, FileArchive],
  [/^(mp3|wav|m4a|aac|flac|aiff)$/, FileAudio],
  [/^(mp4|mov|avi|mkv|webm)$/, FileVideo],
  [/^(png|jpg|jpeg|gif|webp|heic|svg|bmp|tiff)$/, FileImage],
];

export function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

function iconFor(name: string, type: string): LucideIcon {
  if (type.startsWith("image/")) return FileImage;
  if (type.startsWith("audio/")) return FileAudio;
  if (type.startsWith("video/")) return FileVideo;
  const ext = extensionOf(name);
  return ICON_BY_EXT.find(([re]) => re.test(ext))?.[1] ?? File;
}

/** 사람이 읽는 크기. 0 은 크기를 모르는 경우(예: 지난 대화에서 복원)라 숨긴다. */
export function formatBytes(bytes: number): string {
  if (!bytes || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
  const mb = kb / 1024;
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}

function isImage(f: AttachedFile): boolean {
  return !!f.dataUrl || f.type.startsWith("image/");
}

interface Props {
  files: AttachedFile[];
  /** 주면 카드마다 지우기 버튼이 붙는다(입력창에서만). */
  onRemove?: (index: number) => void;
  /** 입력창은 더 작게. 말풍선에서는 그림이 커도 된다. */
  compact?: boolean;
}

export function Attachments({ files, onRemove, compact = false }: Props) {
  if (files.length === 0) return null;

  return (
    <div className={`atts ${compact ? "atts--compact" : ""}`}>
      {files.map((f, i) => {
        const Icon = iconFor(f.name, f.type);
        const size = formatBytes(f.size);
        const ext = extensionOf(f.name);
        return isImage(f) && f.dataUrl ? (
          <figure key={i} className="att att--image" title={f.name}>
            <img className="att__preview" src={f.dataUrl} alt={f.name} />
            {onRemove && <RemoveButton onClick={() => onRemove(i)} />}
          </figure>
        ) : (
          <div key={i} className="att att--file" title={f.name}>
            <span className="att__icon"><Icon size={compact ? 13 : 15} strokeWidth={1.75} /></span>
            <span className="att__meta">
              <span className="att__name">{f.name}</span>
              <span className="att__sub">{[ext.toUpperCase(), size].filter(Boolean).join(" · ")}</span>
            </span>
            {onRemove && <RemoveButton onClick={() => onRemove(i)} />}
          </div>
        );
      })}
    </div>
  );
}

function RemoveButton({ onClick }: { onClick: () => void }) {
  return (
    <button className="att__remove" onClick={onClick} title="제거" aria-label="첨부 제거">
      <X size={11} strokeWidth={2.5} />
    </button>
  );
}
