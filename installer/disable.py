"""Disable only the plugin registry entry. Never touch Host files or user data."""
import json
import os
from bridge_config import INSTALLED


def replace_if_unchanged(file, before, after):
    if file.read_bytes()!=before:raise RuntimeError('文件已变化，拒绝覆盖：'+str(file))
    temporary=file.with_name(file.name+'.disable.tmp')
    with temporary.open('xb') as stream:stream.write(after)
    try:
        if file.read_bytes()!=before:raise RuntimeError('文件已变化，拒绝覆盖：'+str(file))
        os.replace(temporary,file)
    finally:
        if temporary.exists():temporary.unlink()


def disable(registry):
    # CodexHost 0.15.0 exposes enabled.json discovery, no plugin-disable CLI.
    if registry.exists():
        raw=registry.read_bytes();value=json.loads(raw)
        if value.get('version')!=1 or not isinstance(value.get('enabled'),list):raise RuntimeError('插件注册表格式不匹配')
        value['enabled']=[name for name in value['enabled'] if name!='claude-vps']
        replace_if_unchanged(registry,raw,(json.dumps(value,ensure_ascii=False,indent=2)+'\n').encode())
    return {'disabled':True,'dataPreserved':True,'codePreserved':True,'restartRequired':True}


def main():
    if os.environ.get('CODEXHOST_PLUGIN_DIRECTORY') or os.environ.get('CODEXHOST_DATA_DIR'):raise RuntimeError('自定义插件目录尚不支持此入口')
    print(json.dumps(disable(INSTALLED.parent/'enabled.json')))

if __name__=='__main__':main()
