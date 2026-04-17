import { describe, expect, it } from 'vitest';

import { normalizeUnderscoreEmphasis } from '~/slack/render/slack-renderer.js';

describe('normalizeUnderscoreEmphasis', () => {
  it('converts _emphasis_ adjacent to CJK characters', () => {
    expect(normalizeUnderscoreEmphasis('包含_斜体内容_。')).toBe('包含*斜体内容*。');
  });

  it('converts _emphasis_ mixed with bold and CJK', () => {
    expect(normalizeUnderscoreEmphasis('包含**加粗**和_斜体_。')).toBe('包含**加粗**和*斜体*。');
  });

  it('converts _emphasis_ in normal English text', () => {
    expect(normalizeUnderscoreEmphasis('hello _italic_ world')).toBe('hello *italic* world');
  });

  it('preserves underscores inside fenced code blocks', () => {
    const md = '```\nsome_var_name\n```';
    expect(normalizeUnderscoreEmphasis(md)).toBe(md);
  });

  it('preserves underscores inside inline code', () => {
    const md = '使用 `some_var` 变量';
    expect(normalizeUnderscoreEmphasis(md)).toBe(md);
  });

  it('does not convert snake_case identifiers', () => {
    expect(normalizeUnderscoreEmphasis('use my_var_name here')).toBe('use my_var_name here');
  });

  it('handles mixed emphasis, inline code, and CJK', () => {
    expect(normalizeUnderscoreEmphasis('**加粗**和_斜体_以及`code_var`')).toBe(
      '**加粗**和*斜体*以及`code_var`',
    );
  });

  it('preserves __double underscores__ (bold marker)', () => {
    expect(normalizeUnderscoreEmphasis('__双下划线加粗__和_斜体_')).toBe(
      '__双下划线加粗__和*斜体*',
    );
  });

  it('returns empty string unchanged', () => {
    expect(normalizeUnderscoreEmphasis('')).toBe('');
  });

  it('returns plain text without underscores unchanged', () => {
    const md = '没有任何格式标记的纯文本';
    expect(normalizeUnderscoreEmphasis(md)).toBe(md);
  });

  it('converts multiple _emphasis_ spans in one line', () => {
    expect(normalizeUnderscoreEmphasis('_第一个_和_第二个_')).toBe('*第一个*和*第二个*');
  });

  it('preserves underscores in fenced code with tilde syntax', () => {
    const md = '~~~\nsome_var_name\n~~~';
    expect(normalizeUnderscoreEmphasis(md)).toBe(md);
  });

  it('converts emphasis around code block but not inside', () => {
    const md = '_斜体_\n\n```\nkeep_this\n```\n\n_另一个_';
    expect(normalizeUnderscoreEmphasis(md)).toBe('*斜体*\n\n```\nkeep_this\n```\n\n*另一个*');
  });

  it('does not convert single underscore without closing pair', () => {
    expect(normalizeUnderscoreEmphasis('这里有个_没有闭合')).toBe('这里有个_没有闭合');
  });

  it('handles Japanese text with emphasis', () => {
    expect(normalizeUnderscoreEmphasis('_日本語テスト_です')).toBe('*日本語テスト*です');
  });

  it('handles Korean text with emphasis', () => {
    expect(normalizeUnderscoreEmphasis('_한국어 테스트_입니다')).toBe('*한국어 테스트*입니다');
  });
});
