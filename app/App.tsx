import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Button } from './Button.tsx';

interface Todo {
  id: number;
  text: string;
  done: boolean;
}

function App() {
  const [todos, setTodos] = useState<Todo[]>([
    { id: 1, text: '体验一下 Super Agent 生成的应用', done: false },
    { id: 2, text: '试试在真实模型上让它做别的页面', done: false },
  ]);
  const [input, setInput] = useState('');

  function add() {
    if (!input.trim()) return;
    setTodos([...todos, { id: Date.now(), text: input, done: false }]);
    setInput('');
  }

  function toggle(id: number) {
    setTodos(todos.map(t => t.id === id ? { ...t, done: !t.done } : t));
  }

  function remove(id: number) {
    setTodos(todos.filter(t => t.id !== id));
  }

  const remaining = todos.filter(t => !t.done).length;

  return (
    <div className="container">
      <h1>📝 我的待办清单</h1>
      <p className="subtitle">还有 {remaining} 件事没做</p>

      <div className="input-row">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') add(); }}
          placeholder="输入新的待办事项..."
        />
        <Button onClick={add}>添加</Button>
      </div>

      <ul className="todo-list">
        {todos.map(todo => (
          <li key={todo.id} className={todo.done ? 'done' : ''}>
            <span onClick={() => toggle(todo.id)}>{todo.text}</span>
            <Button variant="danger" onClick={() => remove(todo.id)}>×</Button>
          </li>
        ))}
      </ul>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
