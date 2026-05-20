import { useState } from 'react';
import { Input, Tag } from 'tdesign-react';
import { FolderOpenIcon } from 'tdesign-icons-react';
import { Bot, Headphones } from 'lucide-react';
import { APP_CONFIG } from '../config';
import { Model, Agent, PermissionMode } from '../types';
import { ICON_MAP } from '../utils/iconMap';

interface NewChatViewProps {
  agents: Agent[];
  models: Model[];
  selectedModel: string;
  newChatAgentId: string;
  newChatCwd: string;
  newChatPermissionMode: PermissionMode;
  onSelectModel: (modelId: string) => void;
  onSelectAgent: (agentId: string) => void;
  onSetCwd: (cwd: string) => void;
  onSetPermissionMode: (mode: PermissionMode) => void;
  onQuickQuestion?: (question: string) => void;
}

const QUICK_QUESTIONS = [
  { label: '如何申请退款？', icon: '💰' },
  { label: '我的快递到哪了？', icon: '📦' },
  { label: 'App 闪退怎么办？', icon: '📱' },
  { label: '支付失败怎么办？', icon: '💳' },
  { label: '登录不上去了', icon: '🔑' },
  { label: '联系人工客服', icon: '🎧' },
];

export function NewChatView({
  agents,
  newChatAgentId,
  newChatCwd,
  onSelectAgent,
  onSetCwd,
  onSetPermissionMode,
  onQuickQuestion,
}: NewChatViewProps) {
  const selectedAgent = agents.find(a => a.id === newChatAgentId);

  return (
    <div className="flex flex-col items-center justify-center h-full">
      <div className="w-full max-w-lg">
        {/* Logo 和标题 */}
        <div className="text-center mb-8">
          <div
            className="w-20 h-20 rounded-2xl flex items-center justify-center mb-4 shadow-lg mx-auto"
            style={{
              background: 'linear-gradient(135deg, #3b82f6, #8b5cf6)'
            }}
          >
            <Headphones size={36} color="white" />
          </div>
          <h2
            className="text-2xl font-bold mb-1"
            style={{ color: 'var(--td-text-color-primary)' }}
          >
            SmartCS 智能客服
          </h2>
          <p className="text-sm" style={{ color: 'var(--td-text-color-secondary)' }}>
            您好，我是智能客服助手，有什么可以帮您的？
          </p>
        </div>

        {/* 快捷问题 */}
        <div className="mb-6">
          <p className="text-xs font-medium mb-3 text-center" style={{ color: 'var(--td-text-color-placeholder)' }}>
            试试这些问题
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {QUICK_QUESTIONS.map((q) => (
              <div
                key={q.label}
                className="flex items-center gap-2 px-4 py-2.5 rounded-xl cursor-pointer transition-all border hover:shadow-sm"
                style={{
                  backgroundColor: 'var(--td-bg-color-component)',
                  borderColor: 'var(--td-component-stroke)',
                }}
                onClick={() => onQuickQuestion?.(q.label)}
                onMouseEnter={(e) => {
                  e.currentTarget.style.borderColor = 'var(--td-brand-color)';
                  e.currentTarget.style.backgroundColor = 'var(--td-brand-color-light)';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.borderColor = 'var(--td-component-stroke)';
                  e.currentTarget.style.backgroundColor = 'var(--td-bg-color-component)';
                }}
              >
                <span className="text-lg">{q.icon}</span>
                <span className="text-sm" style={{ color: 'var(--td-text-color-primary)' }}>{q.label}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Agent 选择 */}
        <div className="mb-6">
          <label className="block text-sm font-medium mb-3" style={{ color: 'var(--td-text-color-primary)' }}>
            选择 Agent
          </label>
          <div className="grid grid-cols-2 gap-3 max-h-[280px] overflow-y-auto">
            {agents.map(agent => {
              const AgentIcon = ICON_MAP[agent.icon || 'Bot'] || Bot;
              const isSelected = agent.id === newChatAgentId;
              return (
                <div
                  key={agent.id}
                  className="p-3 rounded-xl cursor-pointer transition-all border-2"
                  style={{
                    borderColor: isSelected ? (agent.color || 'var(--td-brand-color)') : 'transparent',
                    backgroundColor: isSelected ? 'var(--td-brand-color-light)' : 'var(--td-bg-color-component)',
                  }}
                  onClick={() => {
                    onSelectAgent(agent.id);
                    if (agent.permissionMode) {
                      onSetPermissionMode(agent.permissionMode);
                    }
                  }}
                >
                  <div className="flex items-center gap-3">
                    <div
                      className="w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0"
                      style={{ backgroundColor: agent.color || '#0052d9' }}
                    >
                      <AgentIcon size={20} color="white" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium truncate" style={{ color: 'var(--td-text-color-primary)' }}>
                        {agent.name}
                      </div>
                      {agent.description && (
                        <div className="text-xs truncate mt-0.5" style={{ color: 'var(--td-text-color-placeholder)' }}>
                          {agent.description}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* 工作目录 */}
        <div className="mb-6">
          <label className="block text-sm font-medium mb-2" style={{ color: 'var(--td-text-color-primary)' }}>
            工作目录 <span style={{ color: 'var(--td-text-color-placeholder)' }}>(可选)</span>
          </label>
          <Input
            value={newChatCwd}
            onChange={(v) => onSetCwd(v as string)}
            placeholder="例如：/Users/username/projects/my-app"
            prefixIcon={<FolderOpenIcon />}
          />
          <p className="text-xs mt-1.5" style={{ color: 'var(--td-text-color-placeholder)' }}>
            指定 Agent 的工作目录，用于文件操作等
          </p>
        </div>

        {/* 选中的 Agent 预览 */}
        {selectedAgent && (
          <div
            className="p-4 rounded-xl"
            style={{ backgroundColor: 'var(--td-bg-color-component)' }}
          >
            <div className="flex items-center gap-2 mb-2">
              {(() => {
                const Icon = ICON_MAP[selectedAgent.icon || 'Bot'] || Bot;
                return (
                  <>
                    <div
                      className="w-6 h-6 rounded-md flex items-center justify-center"
                      style={{ backgroundColor: selectedAgent.color || '#0052d9' }}
                    >
                      <Icon size={14} color="white" />
                    </div>
                    <span className="text-sm font-medium" style={{ color: 'var(--td-text-color-primary)' }}>
                      {selectedAgent.name}
                    </span>
                  </>
                );
              })()}
            </div>
            <p className="text-xs line-clamp-2" style={{ color: 'var(--td-text-color-secondary)' }}>
              {selectedAgent.systemPrompt}
            </p>
          </div>
        )}

        {/* 提示文字 */}
        <p className="text-center text-xs mt-6" style={{ color: 'var(--td-text-color-placeholder)' }}>
          模型和权限模式可在输入框下方切换
        </p>
      </div>
    </div>
  );
}
