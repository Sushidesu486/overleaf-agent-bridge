#!/bin/sh
# Exercise the installed packages, font maps and engines used by CE compiles.
set -eu
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT HUP INT TERM
cd "$work"

cat > cjk.tex <<'EOF'
\documentclass{article}
\usepackage{CJKutf8}
\begin{document}
\begin{CJK}{UTF8}{gbsn}
中文编译测试。English and mathematics: $E=mc^2$.
\end{CJK}
\end{document}
EOF

cat > ctex.tex <<'EOF'
\documentclass[fontset=fandol]{ctexart}
\begin{document}
\section{中文编译测试}
中文、English 与数学公式：$E=mc^2$。
\end{document}
EOF

check_compile() {
    engine=$1
    document=$2
    if ! "$engine" -interaction=nonstopmode -halt-on-error "$document.tex" > "$document.stdout" 2>&1; then
        cat "$document.stdout"
        return 1
    fi
    test -s "$document.pdf"
    if grep -q 'Missing character:' "$document.log"; then
        cat "$document.log"
        return 1
    fi
    printf '%s + %s: PDF generated without missing glyphs\n' "$engine" "$document"
}

check_compile pdflatex cjk
check_compile xelatex ctex
