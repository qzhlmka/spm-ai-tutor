import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";

interface MarkdownContentProps {
  content: string;
}

// The tutor model writes math as \(...\) / \[...\], not remark-math's $...$ / $$...$$.
// Converting here (rather than in the system prompt) also protects against CommonMark's
// backslash-escaping, which would otherwise strip the backslash before "\(" reaches KaTeX.
function normalizeMathDelimiters(text: string): string {
  return text
    .replace(/\\\[/g, () => "$$")
    .replace(/\\\]/g, () => "$$")
    .replace(/\\\(/g, () => "$")
    .replace(/\\\)/g, () => "$");
}

/**
 * Renders assistant message text: standard markdown (bold, lists, code) plus
 * LaTeX math via remark-math + rehype-katex ($...$ inline, $$...$$ block).
 */
export function MarkdownContent({ content }: MarkdownContentProps) {
  return (
    <div className="prose prose-neutral max-w-none leading-7 dark:prose-invert prose-p:my-3 prose-headings:font-semibold prose-pre:my-3 first:prose-p:mt-0 last:prose-p:mb-0">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeKatex]}
        components={{
          a: ({ ...props }) => (
            <a {...props} target="_blank" rel="noreferrer noopener" className="underline underline-offset-2" />
          ),
          code: ({ className, children, ...props }) => (
            <code
              className={`${className ?? ""} rounded bg-neutral-100 px-1.5 py-0.5 text-[0.9em] dark:bg-neutral-800`}
              {...props}
            >
              {children}
            </code>
          ),
          pre: ({ children, ...props }) => (
            <pre
              className="overflow-x-auto rounded-lg border border-neutral-200 bg-neutral-50 p-3 text-[0.9em] dark:border-neutral-700 dark:bg-neutral-900 [&_code]:bg-transparent [&_code]:p-0"
              {...props}
            >
              {children}
            </pre>
          ),
        }}
      >
        {normalizeMathDelimiters(content)}
      </ReactMarkdown>
    </div>
  );
}
