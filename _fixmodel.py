# -*- coding: utf-8 -*-
"""让模型跟随供应商（CRLF 兼容）"""
import io

p = 'lib/store.js'
s = io.open(p, encoding='utf-8', newline='').read()
NL = '\r\n' if '\r\n' in s else '\n'


def rep(old, new, required=True):
    global s
    o = old.replace('\n', NL)
    n = new.replace('\n', NL)
    if o not in s:
        if required:
            raise SystemExit('未找到片段:\n' + old[:120])
        return False
    s = s.replace(o, n, 1)
    return True


# 1) profileFor：模型名跟随供应商
rep(
"""    if (!provider) {
      return { label: prof.label || role, model: prof.model || '', baseUrl: '', apiKey: '', priceIn: 0, priceOut: 0, missing: true };
    }
    return {
      label: prof.label || role, role, model: prof.model || provider.defaultModel || '',
      baseUrl: provider.baseUrl, apiKey: provider.apiKey,
      priceIn: provider.priceIn || 0, priceOut: provider.priceOut || 0, providerId: provider.id, providerName: provider.name,
      maxTokens: prof.maxTokens
    };
  },""",
"""    if (!provider) {
      return { label: prof.label || role, model: prof.modelOverride || prof.model || '', baseUrl: '', apiKey: '', priceIn: 0, priceOut: 0, missing: true };
    }
    /* 模型名跟随供应商 —— 岗位覆盖 > 供应商默认模型 > 岗位旧字段
     * 这样换供应商时模型自动跟着换，不会出现"拿 GLM 的模型名去请求 DeepSeek"。*/
    const ov = (prof.modelOverride || '').trim();
    const pm = (provider.model || '').trim();
    return {
      label: prof.label || role, role,
      model: ov || pm || prof.model || '',
      modelSource: ov ? '岗位覆盖' : (pm ? '供应商默认' : '岗位旧字段'),
      baseUrl: provider.baseUrl, apiKey: provider.apiKey,
      priceIn: provider.priceIn || 0, priceOut: provider.priceOut || 0,
      providerId: provider.id, providerName: provider.name,
      maxTokens: prof.maxTokens
    };
  },

  /* 岗位当前绑定的全部候选（含各自会用到的模型），供 UI 展示"实际会用什么" */
  roleBindings(cfg, role) {
    const prof = (cfg.profiles && cfg.profiles[role]) || {};
    const ov = (prof.modelOverride || '').trim();
    return (prof.providerIds || [])
      .map(id => (cfg.providers || []).find(p => p.id === id))
      .filter(Boolean)
      .map(p => ({
        providerId: p.id, providerName: p.name, hasKey: !!p.apiKey, enabled: p.enabled !== false,
        model: ov || (p.model || '').trim() || prof.model || '',
        modelSource: ov ? '岗位覆盖' : ((p.model || '').trim() ? '供应商默认' : '岗位旧字段'),
        baseUrl: p.baseUrl, priceIn: p.priceIn, priceOut: p.priceOut
      }));
  },""")

# 2) 迁移：把岗位 model 提升为"供应商默认模型"，岗位改为可选覆盖
rep(
"""    /* 补齐缺失角色，并让未绑定供应商的角色回退到主供应商 */""",
"""    /* 迁移：岗位上的 model 原本是"给那个供应商用的模型名"，提升为供应商的默认模型；
     * 岗位侧改为 modelOverride（留空 = 用供应商默认），这样换供应商模型自动跟随。 */
    for (const prof of Object.values(cfg.profiles || {})) {
      if (!prof || prof.modelOverride !== undefined) continue;
      if (prof.model) {
        for (const pid of (prof.providerIds || [])) {
          const p = cfg.providers.find(x => x.id === pid);
          if (p && !p.model) p.model = prof.model;
        }
      }
      prof.modelOverride = '';
    }

    /* 补齐缺失角色，并让未绑定供应商的角色回退到主供应商 */""")

# 3) 默认配置给供应商带默认模型
s = s.replace("enabled: true, note: '主供应商（未配 Key 的岗位会回退到这里）' }",
              "enabled: true, model: 'deepseek-chat', note: '主供应商（未配 Key 的岗位会回退到这里）' }")
s = s.replace("enabled: true, note: '视觉模型与异构质检' }",
              "enabled: true, model: 'glm-4-flash', note: '视觉模型与异构质检' }")

# 4) 清理调试残留字段
s = s.replace("      if (byKey.has(k)) return byKey.get(k).id;", "      if (byKey.has(k)) return byKey.get(k).id;")

io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('store.js：模型已跟随供应商')
