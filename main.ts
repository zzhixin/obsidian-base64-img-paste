import {
  App,
  Editor,
  MarkdownView,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  editorInfoField,
  normalizePath
} from "obsidian";
import {
  Annotation,
  EditorSelection,
  EditorState,
  Prec,
  StateEffect,
  Transaction,
  TransactionSpec
} from "@codemirror/state";
import { EditorView, ViewPlugin, ViewUpdate } from "@codemirror/view";

interface Base64ImagePasteSettings {
  imageFolder: string;
  defaultImageCaption: string;
}

const DEFAULT_SETTINGS: Base64ImagePasteSettings = {
  imageFolder: "base64-images",
  defaultImageCaption: "image"
};

interface ImageMatch {
  source: string;
  mimeType: string;
  base64: string;
}

const IMAGE_DATA_URL_PATTERN = /data:image\/([a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=\r\n]+)/g;
const QUOTE_CITATION_PREFIX_PATTERN = /^>\s?\[@/;
const deferredPasteEffect = StateEffect.define<{ placeholder: string; text: string }>();
const internalPasteAnnotation = Annotation.define<boolean>();

export default class Base64ImagePastePlugin extends Plugin {
  settings: Base64ImagePasteSettings;

  async onload() {
    await this.loadSettings();

    this.registerEditorExtension([
      Prec.highest(
        EditorView.domEventHandlers({
          keydown: (event, view) => this.handleEditorKeydown(event, view)
        })
      ),
      EditorState.transactionFilter.of((tr) => this.filterPasteTransaction(tr)),
      ViewPlugin.fromClass(
        class {
          plugin: Base64ImagePastePlugin;
          view: EditorView;

          constructor(view: EditorView) {
            this.view = view;
            this.plugin = Base64ImagePastePlugin.instance;
          }

          update(update: ViewUpdate) {
            for (const transaction of update.transactions) {
              for (const effect of transaction.effects) {
                if (effect.is(deferredPasteEffect)) {
                  void this.plugin.resolveDeferredPaste(update.view, effect.value);
                }
              }
            }
          }
        }
      )
    ]);

    this.registerDomEvent(
      document,
      "paste",
      (event: ClipboardEvent) => {
        void this.handlePaste(event);
      },
      { capture: true }
    );

    this.registerDomEvent(
      document,
      "keydown",
      (event: KeyboardEvent) => {
        void this.handleDocumentKeydown(event);
      },
      { capture: true }
    );

    this.addSettingTab(new Base64ImagePasteSettingTab(this.app, this));
  }

  static instance: Base64ImagePastePlugin;

  async loadSettings() {
    Base64ImagePastePlugin.instance = this;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  private async handlePaste(event: ClipboardEvent) {
    const editor = this.getActiveMarkdownEditor();
    if (!editor) {
      return;
    }

    const clipboardText = event.clipboardData?.getData("text/plain") ?? "";
    if (!clipboardText) {
      return;
    }

    const images = this.findBase64Images(clipboardText);
    const shouldInsertQuoteCallout = this.shouldInsertQuoteCallout(clipboardText);
    if (images.length === 0 && !shouldInsertQuoteCallout) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    try {
      const replacement = await this.transformClipboardText(
        clipboardText,
        images,
        shouldInsertQuoteCallout
      );
      editor.replaceSelection(replacement);
      if (images.length > 0) {
        new Notice(`已保存 ${images.length} 张 base64 图片`);
      }
    } catch (error) {
      console.error("Base64 image paste failed", error);
      new Notice("剪切板内容处理失败，未插入原始 base64 内容");
    }
  }

  private handleEditorKeydown(event: KeyboardEvent, view: EditorView): boolean {
    if (
      event.key !== "p" ||
      event.ctrlKey ||
      event.metaKey ||
      event.altKey ||
      event.shiftKey ||
      !view.hasFocus ||
      !view.dom.classList.contains("cm-fat-cursor")
    ) {
      return false;
    }

    const info = view.state.field(editorInfoField, false);
    const editor = info?.editor;
    if (!editor || editor.somethingSelected() || !navigator.clipboard?.readText) {
      return false;
    }

    event.preventDefault();
    event.stopPropagation();
    void this.handleVimPasteFromClipboard(editor);
    return true;
  }

  private async handleDocumentKeydown(event: KeyboardEvent) {
    if (
      event.key !== "p" ||
      event.ctrlKey ||
      event.metaKey ||
      event.altKey ||
      event.shiftKey ||
      event.defaultPrevented
    ) {
      return;
    }

    const editor = this.getActiveMarkdownEditor();
    if (!editor || editor.somethingSelected()) {
      return;
    }

    const isVimNormalMode = this.isEventFromVimNormalMode(event);
    if (!isVimNormalMode || !navigator.clipboard?.readText) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    await this.handleVimPasteFromClipboard(editor);
  }

  private async handleVimPasteFromClipboard(editor: Editor) {
    try {
      const clipboardText = await navigator.clipboard.readText();
      if (!clipboardText) {
        return;
      }

      const images = this.findBase64Images(clipboardText);
      const shouldInsertQuoteCallout = this.shouldInsertQuoteCallout(clipboardText);
      const replacement =
        images.length > 0 || shouldInsertQuoteCallout
          ? await this.transformClipboardText(clipboardText, images, shouldInsertQuoteCallout)
          : clipboardText;

      this.insertTextForVimPaste(editor, replacement);
      if (images.length > 0) {
        new Notice(`已保存 ${images.length} 张 base64 图片`);
      }
    } catch (error) {
      console.error("Vim paste takeover failed", error);
      new Notice("Vim p 接管失败");
    }
  }

  private filterPasteTransaction(tr: Transaction): TransactionSpec | readonly TransactionSpec[] {
    if (tr.annotation(internalPasteAnnotation)) {
      return tr;
    }

    if (!tr.docChanged || !tr.isUserEvent("input.paste")) {
      return tr;
    }

    const pastedChange = this.getSinglePastedChange(tr);
    if (!pastedChange) {
      return tr;
    }

    const images = this.findBase64Images(pastedChange.text);
    const shouldInsertQuoteCallout = this.shouldInsertQuoteCallout(pastedChange.text);
    if (images.length === 0 && !shouldInsertQuoteCallout) {
      return tr;
    }

    if (images.length === 0) {
      return {
        changes: {
          from: pastedChange.from,
          to: pastedChange.to,
          insert: this.insertQuoteCallout(pastedChange.text)
        }
      };
    }

    const placeholder = this.createDeferredPastePlaceholder();
    return {
      changes: {
        from: pastedChange.from,
        to: pastedChange.to,
        insert: placeholder
      },
      effects: deferredPasteEffect.of({
        placeholder,
        text: pastedChange.text
      })
    };
  }

  private getSinglePastedChange(tr: Transaction): { from: number; to: number; text: string } | null {
    let change: { from: number; to: number; text: string } | null = null;
    let hasMultipleChanges = false;

    tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
      if (change) {
        hasMultipleChanges = true;
        return;
      }

      change = {
        from: fromA,
        to: toA,
        text: inserted.toString()
      };
    });

    if (!change || hasMultipleChanges) {
      return null;
    }

    return change;
  }

  private createDeferredPastePlaceholder(): string {
    return `![processing-image](base64-img-paste-${Date.now()}-${Math.random().toString(36).slice(2)})`;
  }

  private async resolveDeferredPaste(
    view: EditorView,
    payload: { placeholder: string; text: string }
  ): Promise<void> {
    const images = this.findBase64Images(payload.text);
    const shouldInsertQuoteCallout = this.shouldInsertQuoteCallout(payload.text);
    if (images.length === 0 && !shouldInsertQuoteCallout) {
      return;
    }

    try {
      const replacement = await this.transformClipboardText(
        payload.text,
        images,
        shouldInsertQuoteCallout
      );
      const currentText = view.state.doc.toString();
      const from = currentText.indexOf(payload.placeholder);
      if (from === -1) {
        return;
      }

      const to = from + payload.placeholder.length;
      view.dispatch({
        changes: { from, to, insert: replacement },
        selection: EditorSelection.cursor(from + replacement.length),
        annotations: internalPasteAnnotation.of(true)
      });

      if (images.length > 0) {
        new Notice(`已保存 ${images.length} 张 base64 图片`);
      }
    } catch (error) {
      console.error("Deferred base64 image paste failed", error);
      new Notice("Vim 粘贴处理失败，已保留占位符避免插入原始 base64 内容");
    }
  }

  private getActiveMarkdownEditor(): Editor | null {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view?.editor.hasFocus()) {
      return null;
    }

    return view.editor;
  }

  private insertTextForVimPaste(editor: Editor, text: string) {
    const cursor = editor.getCursor("head");
    const lineText = editor.getLine(cursor.line);
    const cursorOffset = editor.posToOffset(cursor);
    const insertOffset =
      lineText.length === 0 ? cursorOffset : Math.min(cursorOffset + 1, editor.getValue().length);
    const insertPosition = editor.offsetToPos(insertOffset);

    editor.replaceRange(text, insertPosition, insertPosition);
    editor.setCursor(editor.offsetToPos(insertOffset + text.length));
  }

  private findBase64Images(text: string): ImageMatch[] {
    const matches: ImageMatch[] = [];
    IMAGE_DATA_URL_PATTERN.lastIndex = 0;

    let match: RegExpExecArray | null;
    while ((match = IMAGE_DATA_URL_PATTERN.exec(text)) !== null) {
      matches.push({
        source: match[0],
        mimeType: `image/${match[1].toLowerCase()}`,
        base64: match[2].replace(/\s/g, "")
      });
    }

    return matches;
  }

  private shouldInsertQuoteCallout(text: string): boolean {
    return QUOTE_CITATION_PREFIX_PATTERN.test(text);
  }

  private async transformClipboardText(
    text: string,
    images: ImageMatch[],
    shouldInsertQuoteCallout: boolean
  ): Promise<string> {
    let transformedText = text;

    if (images.length > 0) {
      transformedText = await this.replaceImagesWithEmbeds(transformedText, images);
    }

    if (shouldInsertQuoteCallout) {
      transformedText = this.insertQuoteCallout(transformedText);
    }

    return transformedText;
  }

  private insertQuoteCallout(text: string): string {
    return text.replace(/^>\s?(\[@)/, "> [!quote] $1");
  }

  private async replaceImagesWithEmbeds(text: string, images: ImageMatch[]): Promise<string> {
    const replacements = new Map<string, string>();

    for (const image of images) {
      if (replacements.has(image.source)) {
        continue;
      }

      const pngData = await this.toPngArrayBuffer(image);
      const imagePath = await this.savePngImage(pngData);
      replacements.set(image.source, this.buildImageEmbed(imagePath));
    }

    return text.replace(IMAGE_DATA_URL_PATTERN, (source) => replacements.get(source) ?? source);
  }

  private buildImageEmbed(imagePath: string): string {
    const caption = this.settings.defaultImageCaption.trim();
    return `![${caption}](${imagePath})`;
  }

  private async savePngImage(data: ArrayBuffer): Promise<string> {
    const folder = normalizePath(this.settings.imageFolder.trim() || DEFAULT_SETTINGS.imageFolder);
    await this.ensureFolder(folder);

    let path = "";
    for (let index = 0; index < 1000; index += 1) {
      const suffix = index === 0 ? "" : `-${index}`;
      path = normalizePath(`${folder}/${this.getTimestamp()}${suffix}.png`);
      if (!(await this.app.vault.adapter.exists(path))) {
        break;
      }
    }

    await this.app.vault.createBinary(path, data);
    return path;
  }

  private async ensureFolder(folder: string) {
    const parts = folder.split("/").filter(Boolean);
    let current = "";

    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      const existing = this.app.vault.getAbstractFileByPath(current);
      if (existing instanceof TFile) {
        throw new Error(`${current} is a file, not a folder`);
      }
      if (!existing) {
        await this.app.vault.createFolder(current);
      }
    }
  }

  private getTimestamp(): string {
    const now = new Date();
    const pad = (value: number, length = 2) => value.toString().padStart(length, "0");

    return [
      now.getFullYear(),
      pad(now.getMonth() + 1),
      pad(now.getDate()),
      "-",
      pad(now.getHours()),
      pad(now.getMinutes()),
      pad(now.getSeconds()),
      "-",
      pad(now.getMilliseconds(), 3)
    ].join("");
  }

  private async toPngArrayBuffer(image: ImageMatch): Promise<ArrayBuffer> {
    if (image.mimeType === "image/png") {
      return this.base64ToArrayBuffer(image.base64);
    }

    return this.convertImageToPng(image.source);
  }

  private base64ToArrayBuffer(base64: string): ArrayBuffer {
    const binary = window.atob(base64);
    const bytes = new Uint8Array(binary.length);

    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }

    return bytes.buffer;
  }

  private async convertImageToPng(dataUrl: string): Promise<ArrayBuffer> {
    const image = await this.loadImage(dataUrl);
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;

    const context = canvas.getContext("2d");
    if (!context) {
      throw new Error("Could not create canvas context");
    }

    context.drawImage(image, 0, 0);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!blob) {
      throw new Error("Could not convert image to PNG");
    }

    return blob.arrayBuffer();
  }

  private async loadImage(dataUrl: string): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error("Could not load base64 image"));
      image.src = dataUrl;
    });
  }

  private isEventFromVimNormalMode(event: KeyboardEvent): boolean {
    const activeElement = document.activeElement;
    const eventTarget = event.target;
    const editorElement =
      activeElement instanceof HTMLElement
        ? activeElement.closest(".cm-editor")
        : eventTarget instanceof HTMLElement
          ? eventTarget.closest(".cm-editor")
          : null;

    if (!(editorElement instanceof HTMLElement)) {
      return false;
    }

    return editorElement.querySelector(".cm-fat-cursor") !== null;
  }
}

class Base64ImagePasteSettingTab extends PluginSettingTab {
  plugin: Base64ImagePastePlugin;

  constructor(app: App, plugin: Base64ImagePastePlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("图片存储文件夹名称")
      .setDesc("base64 图片会保存到该 vault 相对路径中。")
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_SETTINGS.imageFolder)
          .setValue(this.plugin.settings.imageFolder)
          .onChange(async (value) => {
            const normalizedValue = normalizePath(value.trim() || DEFAULT_SETTINGS.imageFolder);
            this.plugin.settings.imageFolder = normalizedValue;
            await this.plugin.saveSettings();

            if (/\s/.test(normalizedValue)) {
              new Notice("图片存储路径包含空格，插入的 Markdown 图片路径可能无法按预期工作。");
            }
          })
      );

    new Setting(containerEl)
      .setName("默认插入图片的 caption 名称")
      .setDesc("生成 Markdown 图片引用时使用的默认 caption 文本。留空则插入空 caption。")
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_SETTINGS.defaultImageCaption)
          .setValue(this.plugin.settings.defaultImageCaption)
          .onChange(async (value) => {
            this.plugin.settings.defaultImageCaption = value;
            await this.plugin.saveSettings();
          })
      );
  }
}
