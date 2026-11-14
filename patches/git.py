"""Install the Git adapter after the existing version-checked CE patches."""
from pathlib import Path

settings = Path('/overleaf/services/web/config/settings.defaults.js')
source = settings.read_text()
needle = "    'agent-access',"
assert source.count(needle) == 1, 'Git module registration context changed'
settings.write_text(source.replace(needle, needle + "\n    'git-access',"))

nginx = Path('/etc/nginx/sites-enabled/overleaf.conf')
source = nginx.read_text()
needle = '\tlocation / {'
assert source.count(needle) == 1, 'Git proxy context changed'
source = source.replace(needle, r'''
  # Resolve only when used so the application also starts without the optional bridge.
  location ~ "^/git/([a-f0-9]{24})(\.git)?/(info/refs|git-upload-pack|git-receive-pack)$" {
    access_log off;
    error_log /dev/null crit;
    resolver 127.0.0.11 valid=10s;
    set $git_project $1;
    set $git_operation $3;
    set $git_upstream http://git-bridge:8000;
    proxy_pass $git_upstream/$git_project/$git_operation$is_args$args;
    proxy_http_version 1.1;
    proxy_set_header Host $http_host;
    proxy_set_header Connection "";
    proxy_request_buffering off;
    proxy_buffering off;
    proxy_read_timeout 180s;
    client_max_body_size 500m;
  }
  location /git/ { return 404; }

''' + needle)
nginx.write_text(source)
