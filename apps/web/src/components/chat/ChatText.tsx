/** 助手输出用 Markdown 渲染；默认不执行 HTML。用户消息仍按纯文本显示。 */
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

const components: Components = {
  a: ({ node, children, ...props }) => {
    void node;
    return <a {...props} target="_blank" rel="noopener noreferrer">{children}</a>;
  },
};

export function ChatText({ text, markdown = false }: { text: string; markdown?: boolean }) {
  if (!markdown) return <>{text}</>;
  return (
    <div className="chat-markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>{text}</ReactMarkdown>
    </div>
  );
}
