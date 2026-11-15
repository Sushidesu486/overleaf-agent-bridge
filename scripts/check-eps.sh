#!/bin/sh
# Exercise the XeLaTeX -> xdvipdfmx -> Ghostscript path used by EPS figures.
set -eu
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT HUP INT TERM
cd "$work"
cat > figure.eps <<'EOF'
%!PS-Adobe-3.0 EPSF-3.0
%%BoundingBox: 0 0 200 100
%%EndComments
/Helvetica findfont 16 scalefont setfont
10 50 moveto (EPS conversion check) show
newpath 5 5 moveto 195 5 lineto 195 95 lineto 5 95 lineto closepath stroke
showpage
%%EOF
EOF
cat > report.tex <<'EOF'
\documentclass{article}
\usepackage{graphicx}
\begin{document}
\includegraphics[width=0.8\textwidth]{figure.eps}
\end{document}
EOF
if ! xelatex -no-pdf -interaction=nonstopmode -halt-on-error report.tex > compile.stdout 2>&1; then
    cat compile.stdout
    exit 1
fi
xdvipdfmx -E -o report.pdf report.xdv
pdfinfo report.pdf | grep -Eq '^Pages:[[:space:]]+1$'
printf 'xelatex: EPS conversion produced a valid one-page PDF\n'
