#!/bin/sh
# Compile the team's report preamble, including actual minted code highlighting.
set -eu
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT HUP INT TERM
cd "$work"
cat > report.tex <<'EOF'
\documentclass{report}
\usepackage[utf8]{inputenc}
\usepackage{hyperref}
\usepackage[table,xcdraw]{xcolor}
\usepackage{color}
\usepackage{float}
\usepackage{graphicx}
\usepackage{mathtools}
\usepackage{eso-pic}
\usepackage{geometry}
\usepackage{listings}
\usepackage[super]{nth}
\usepackage{setspace}
\usepackage{booktabs}
\usepackage{diagbox}
\usepackage{minted}
\usepackage{caption}
\geometry{a4paper,margin=25mm}
\begin{document}
\chapter{OverLeaf@ZJUSCT report template}
The \nth{26} competition report uses \href{https://www.zju.edu.cn}{Zhejiang University} branding.
\begin{align}
  E &= mc^2 \\
  f(x) &\coloneqq \lVert x \rVert^2
\end{align}
\begin{table}[H]
\centering
\caption{Package compatibility}
\begin{tabular}{ll}
\toprule
\diagbox{Node}{Test} & Result \\
\midrule
\rowcolor{gray!15} CPU & Passed \\
GPU & Passed \\
\bottomrule
\end{tabular}
\end{table}
\begin{minted}[linenos]{python}
def hello():
    return "OverLeaf@ZJUSCT"
\end{minted}
\begin{lstlisting}[language=C]
int main(void) { return 0; }
\end{lstlisting}
\end{document}
EOF
for engine in pdflatex xelatex; do
    mkdir "$engine"
    cp report.tex "$engine/"
    (
        cd "$engine"
        if ! "$engine" -interaction=nonstopmode -halt-on-error report.tex > compile.stdout 2>&1; then
            tail -65 compile.stdout
            exit 1
        fi
        test -s report.pdf
        # A PDF with minted draft placeholders is not a successful highlight test.
        test -n "$(find . -name '*.highlight.minted' -print -quit)"
        if grep -q 'Missing character:' report.log; then
            cat report.log
            exit 1
        fi
        printf '%s: report PDF and minted highlighted output generated\n' "$engine"
    )
done
