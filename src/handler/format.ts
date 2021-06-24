import { Neovim } from '@chemzqm/neovim'
import { CancellationTokenSource, Position, Range, TextEdit } from 'vscode-languageserver-protocol'
import events from '../events'
import languages from '../languages'
import Document from '../model/document'
import snippetManager from '../snippets/manager'
import { ConfigurationChangeEvent, HandlerDelegate } from '../types'
import { getChangedFromEdits } from '../util/position'
import { isWord } from '../util/string'
import window from '../window'
import workspace from '../workspace'
import { synchronizeDocument } from './helper'
const logger = require('../util/logger')('handler-format')

const pairs: Map<string, string> = new Map([
  ['<', '>'],
  ['>', '<'],
  ['{', '}'],
  ['[', ']'],
  ['(', ')'],
])

interface FormatPreferences {
  formatOnType: boolean
  formatOnTypeFiletypes: string[]
  formatOnSaveFiletypes: string[]
  bracketEnterImprove: boolean
}

export default class FormatHandler {
  private preferences: FormatPreferences
  private warnedBuffers: Set<number> = new Set()
  constructor(
    private nvim: Neovim,
    private handler: HandlerDelegate
  ) {
    this.loadPreferences()
    handler.addDisposable(workspace.onDidChangeConfiguration(this.loadPreferences, this))
    handler.addDisposable(workspace.onWillSaveTextDocument(event => {
      let { languageId } = event.document
      let filetypes = this.preferences.formatOnSaveFiletypes
      if (filetypes.includes(languageId) || filetypes.includes('*')) {
        let willSaveWaitUntil = async (): Promise<TextEdit[] | undefined> => {
          if (!languages.hasFormatProvider(event.document)) {
            logger.warn(`Format provider not found for ${event.document.uri}`)
            return undefined
          }
          let options = await workspace.getFormatOptions(event.document.uri)
          let tokenSource = new CancellationTokenSource()
          let timer = setTimeout(() => {
            logger.warn(`Onsave format ${event.document.uri} timeout after 1s`)
            tokenSource.cancel()
          }, 1000)
          let textEdits = await languages.provideDocumentFormattingEdits(event.document, options, tokenSource.token)
          clearTimeout(timer)
          if (!textEdits && !tokenSource.token.isCancellationRequested) {
            logger.want(`Onsave format ${event.document.uri} get undefined result.`)
          }
          return textEdits
        }
        event.waitUntil(willSaveWaitUntil())
      }
    }))
    handler.addDisposable(events.on('Enter', async bufnr => {
      let { bracketEnterImprove } = this.preferences
      await this.tryFormatOnType('\n', bufnr)
      if (bracketEnterImprove) {
        let line = (await nvim.call('line', '.') as number) - 1
        let doc = workspace.getDocument(bufnr)
        if (!doc) return
        await doc.patchChange()
        let pre = doc.getline(line - 1)
        let curr = doc.getline(line)
        let prevChar = pre[pre.length - 1]
        if (prevChar && pairs.has(prevChar)) {
          let nextChar = curr.trim()[0]
          if (nextChar && pairs.get(prevChar) == nextChar) {
            let edits: TextEdit[] = []
            let opts = await workspace.getFormatOptions(doc.uri)
            let space = opts.insertSpaces ? ' '.repeat(opts.tabSize) : '\t'
            let currIndent = curr.match(/^\s*/)[0]
            let pos: Position = Position.create(line - 1, pre.length)
            // make sure indent of current line
            if (doc.filetype == 'vim') {
              let newText = '\n' + currIndent + space
              edits.push({ range: Range.create(line, currIndent.length, line, currIndent.length), newText: '  \\ ' })
              newText = newText + '\\ '
              edits.push({ range: Range.create(pos, pos), newText })
              await doc.applyEdits(edits)
              await window.moveTo(Position.create(line, newText.length - 1))
            } else {
              await nvim.eval(`feedkeys("\\<Esc>O", 'in')`)
            }
          }
        }
      }
    }))

    let changedTs: number
    let lastInsert: number
    handler.addDisposable(events.on('InsertCharPre', async () => {
      lastInsert = Date.now()
    }))
    handler.addDisposable(events.on('TextChangedI', async (bufnr, info) => {
      changedTs = Date.now()
      if (!lastInsert || changedTs - lastInsert > 300) return
      lastInsert = null
      let doc = workspace.getDocument(bufnr)
      if (!doc) return
      let pre = info.pre[info.pre.length - 1]
      if (!pre || !languages.hasProvider('onTypeEdit', doc.textDocument)) return
      await this.tryFormatOnType(pre, bufnr)
    }))
    let lastEnterBufnr: number
    let lastEnterTs: number
    handler.addDisposable(events.on('InsertEnter', bufnr => {
      lastEnterBufnr = bufnr
      lastEnterTs = Date.now()
    }))
    handler.addDisposable(events.on('TextChangedI', async (bufnr, info) => {
      if (!this.preferences.formatOnType && !/^\s*$/.test(info.pre)) return
      if (lastEnterBufnr != bufnr || !lastEnterTs || Date.now() - lastEnterTs > 30) return
      await this.tryFormatOnType('\n', bufnr, true)
    }))
  }

  private loadPreferences(e?: ConfigurationChangeEvent): void {
    if (!e || e.affectsConfiguration('coc.preferences')) {
      let config = workspace.getConfiguration('coc.preferences')
      this.preferences = {
        formatOnType: config.get<boolean>('formatOnType', false),
        formatOnSaveFiletypes: config.get<string[]>('formatOnSaveFiletypes', []),
        formatOnTypeFiletypes: config.get('formatOnTypeFiletypes', []),
        bracketEnterImprove: config.get<boolean>('bracketEnterImprove', true),
      }
    }
  }

  private async tryFormatOnType(ch: string, bufnr: number, newLine = false): Promise<void> {
    if (!ch || isWord(ch) || !this.preferences.formatOnType) return
    if (snippetManager.getSession(bufnr) != null) return
    let doc = workspace.getDocument(bufnr)
    if (!doc || !doc.attached || doc.isCommandLine) return
    const filetypes = this.preferences.formatOnTypeFiletypes
    if (filetypes.length && !filetypes.includes(doc.filetype) && !filetypes.includes('*')) {
      // Only check formatOnTypeFiletypes when set, avoid breaking change
      return
    }
    if (!this.warnedBuffers.has(doc.bufnr) && !languages.hasProvider('formatOnType', doc.textDocument)) {
      logger.warn(`Format on type provider not found for buffer: ${doc.bufnr}`)
      this.warnedBuffers.add(doc.bufnr)
      return
    }
    if (!languages.canFormatOnType(ch, doc.textDocument)) return
    let position: Position
    let edits = await this.handler.withRequestToken('Format on type', async token => {
      position = await window.getCursorPosition()
      let origLine = doc.getline(position.line - 1)
      // not format for empty line.
      if (newLine && /^\s*$/.test(origLine)) return
      let pos: Position = newLine ? { line: position.line - 1, character: origLine.length } : position
      await synchronizeDocument(doc)
      return await languages.provideDocumentOnTypeEdits(ch, doc.textDocument, pos, token)
    })
    if (!edits || !edits.length) return
    let changed = getChangedFromEdits(position, edits)
    await doc.applyEdits(edits)
    let to = changed ? Position.create(position.line + changed.line, position.character + changed.character) : null
    if (to && !newLine) await window.moveTo(to)
  }

  public async formatCurrentBuffer(): Promise<boolean> {
    let { doc } = await this.handler.getCurrentState()
    return await this.documentFormat(doc)
  }

  public async formatCurrentRange(mode: string): Promise<number> {
    let { doc } = await this.handler.getCurrentState()
    return await this.documentRangeFormat(doc, mode)
  }

  public async documentFormat(doc: Document): Promise<boolean> {
    await synchronizeDocument(doc)
    if (!languages.hasFormatProvider(doc.textDocument)) {
      throw new Error(`Format provider not found for buffer: ${doc.bufnr}`)
    }
    let options = await workspace.getFormatOptions(doc.uri)
    let textEdits = await this.handler.withRequestToken('format', token => {
      return languages.provideDocumentFormattingEdits(doc.textDocument, options, token)
    })
    if (textEdits && textEdits.length > 0) {
      await doc.applyEdits(textEdits)
      return true
    }
    return false
  }

  public async documentRangeFormat(doc: Document, mode: string): Promise<number> {
    await synchronizeDocument(doc)
    if (!languages.hasProvider('formatRange', doc.textDocument)) {
      throw new Error(`Format range provider not found for buffer: ${doc.bufnr}`)
    }
    let range: Range
    if (mode) {
      range = await workspace.getSelectedRange(mode, doc)
      if (!range) return -1
    } else {
      let [lnum, count, mode] = await this.nvim.eval("[v:lnum,v:count,mode()]") as [number, number, string]
      // we can't handle
      if (count == 0 || mode == 'i' || mode == 'R') return -1
      range = Range.create(lnum - 1, 0, lnum - 1 + count, 0)
    }
    let options = await workspace.getFormatOptions(doc.uri)
    let textEdits = await this.handler.withRequestToken('Format range', token => {
      return languages.provideDocumentRangeFormattingEdits(doc.textDocument, range, options, token)
    })
    if (textEdits && textEdits.length > 0) {
      await doc.applyEdits(textEdits)
      return 0
    }
    return -1
  }
}
