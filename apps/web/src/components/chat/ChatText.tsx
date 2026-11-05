/** 只展示文本与常见加粗标记，不接受模型 HTML；流式未闭合标记继续作为普通文字。 */
export function ChatText({ text }: { text: string }) {
  return <>{text.split(/(\*\*[^*\n]+\*\*)/g).map((part, index) => part.startsWith('**') && part.endsWith('**') && part.length > 4
    ? <strong key={index} className="font-semibold">{part.slice(2, -2)}</strong> : part)}</>;
}
