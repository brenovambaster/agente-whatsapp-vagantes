# Cadastro de Usuarios por Agente de IA

Este README instrui um agente de IA a cadastrar usuarios na API do Vagantes a partir de dados enviados pelo operador, sem depender de scripts ou arquivos locais.

## Objetivo

Receber uma lista de usuarios em texto, CSV, tabela, JSON ou mensagem livre, limpar e normalizar os dados, validar as regras minimas e cadastrar cada usuario na API:

```text
POST https://vagantesmoc.com/api/user
```

Importante: nao usar barra final. `https://vagantesmoc.com/api/user/` pode retornar erro `500` na API atual.

## Autenticacao

Usar o token enviado pelo operador no header:

```http
Authorization: Bearer <TOKEN>
Content-Type: application/json; charset=utf-8
Accept: application/json
```

Nunca exibir o token em logs, respostas finais ou arquivos de resultado.

## Campos de Entrada

O agente deve aceitar dados com nomes de colunas flexiveis e mapear para estes campos:

```text
NomeCompleto
CPF
Telefone
DataNascimento
ContatoEmergenciaNome
ContatoEmergenciaParentesco
ContatoEmergenciaTelefone
CondicoesMedicas
Email
Senha
```

`Email` e `Senha` podem ser omitidos. Se `Senha` nao for informada, o agente deve gerar uma senha forte.

## Payload da API

Enviar um JSON por usuario:

```json
{
  "nomeCompleto": "Maria Silva",
  "email": null,
  "senha": "Senha@123",
  "telefone": "38999999999",
  "dataNascimento": "1990-05-15",
  "cpf": "12345678901",
  "contatoEmergenciaNome": "Joao Silva",
  "contatoEmergenciaParentesco": "Pai",
  "contatoEmergenciaTelefone": "38988888888",
  "condicoesMedicas": "Nao informado"
}
```

Nao enviar `perfil`, `status`, `id`, `emailVerificado` ou qualquer campo administrativo. A API cria usuarios com perfil `CLIENTE`.

## Limpeza e Normalizacao

Antes de enviar para a API:

- Remover tudo que nao for numero de `CPF`, `Telefone` e `ContatoEmergenciaTelefone`.
- Converter datas para `AAAA-MM-DD`.
- Aceitar datas em `DD/MM/AAAA`, `D/M/AAAA`, `AAAA-MM-DD`, `DD-MM-AAAA` ou `DD.MM.AAAA`.
- Normalizar nomes para title case: `MARIA DA SILVA` vira `Maria da Silva`.
- Preservar particulas em minusculo no meio do nome: `da`, `de`, `do`, `das`, `dos`, `e`.
- Tratar texto vazio de `Email` como `null`.
- Se `CondicoesMedicas` estiver vazio, usar `Nao informado`.
- Se `ContatoEmergenciaNome` nao for informado, usar `Nao informado`.
- Se `ContatoEmergenciaParentesco` estiver vazio, usar `Nao informado`.
- Se `ContatoEmergenciaTelefone` nao for informado, usar `00000000000` (onze zeros).
- Se houver dois ou mais contatos de emergencia informados, usar sempre o primeiro contato informado e ignorar os demais.
- Quando todo o contato de emergencia estiver vazio, cadastrar `Nao informado` para nome e parentesco e `00000000000` para telefone.

O telefone de emergencia preenchido com zeros e um valor padrao solicitado pelo operador. Se a API rejeitar esse valor, registrar o retorno da API no resultado individual e nao substituir os zeros automaticamente.

* Se o whatsapp não tiver informado, preecha como 00 000000000
* Se o nome do contato de emergência e/ou telefone de emergência não estiver informado, coloque o nome como "não informado" e telefone como "00 000000000"
* Se data de nascimento não informada, coloque como padrão 10-10-2010
## Validacoes Antes do POST

Nao enviar o usuario se qualquer regra obrigatoria falhar:

- `nomeCompleto`: obrigatorio, entre 3 e 100 caracteres.
- `cpf`: obrigatorio, exatamente 11 digitos.
- `telefone`: não obrigaório, 10 ou 11 digitos. 
- `dataNascimento`: não obrigatoria, coloque como padrão 10-10-2010.
- `senha`: obrigatoria, entre 8 e 100 caracteres.
- `senha`: deve conter ao menos 1 numero, 1 letra minuscula, 1 letra maiuscula e 1 caractere especial aceito.
- `contatoEmergenciaNome`: não obrigatorio apos normalizacao, mas sempre que não informado coloque como "não informado".
- `contatoEmergenciaTelefone`: não  obrigatorio, 10 ou 11 digitos. mas sempre que não informado coloque como "não informado".
- `email`: sempre deixe null, mesmo sendo informado. 

Caracteres especiais aceitos para senha:

```text
@ # $ % ^ & + =
```

Evitar `!` na senha gerada, pois a regex atual do backend nao aceita esse caractere.

## Geracao de Senha

Quando a senha nao for enviada, gerar uma senha aleatoria com 12 caracteres contendo:

- pelo menos 1 letra minuscula;
- pelo menos 1 letra maiuscula;
- pelo menos 1 numero;
- pelo menos 1 caractere especial entre `@#$%^&+=`.

Exemplo valido:

```text
Q7m@v2Lx9pZa
```

## Fluxo de Cadastro

Para cada usuario:

1. Extrair campos da entrada.
2. Limpar e normalizar os valores.
3. Validar regras obrigatorias.
4. Opcionalmente consultar duplicidade por CPF:

```text
GET https://vagantesmoc.com/api/user/by-cpf?cpf=<CPF>
```

5. Se o CPF ja existir, marcar como `JA_EXISTE` e nao tentar criar novamente.
6. Se nao existir, enviar o POST para `https://vagantesmoc.com/api/user`.
7. Registrar status, resposta da API e senha usada.

## Tratamento de Respostas

Status esperados:

- `201`: usuario criado.
- `400`: dados invalidos; corrigir entrada antes de reenviar.
- `409`: CPF ou email ja cadastrado.
- `401`: token ausente, invalido ou expirado.
- `403`: token sem permissao.
- `500`: erro interno da API. Conferir primeiro se o endpoint foi enviado sem barra final.

Se todos os POSTs retornarem `500`, verificar:

- se a URL esta exatamente `https://vagantesmoc.com/api/user`;
- se as senhas nao contem `!` ou outro caractere fora de `@#$%^&+=`;
- se telefones e CPF contem apenas digitos;
- se datas estao em `AAAA-MM-DD`;
- se o JSON foi enviado com `Content-Type: application/json; charset=utf-8`.

## Cadastro em Lote

O agente pode cadastrar em lote, mas deve processar um usuario por vez para conseguir relatar erros individuais.

Nao interromper o lote inteiro por causa de erro em um unico usuario. Registrar o erro daquele usuario e continuar com os proximos.

## Cadastro Um a Um

Quando o operador enviar apenas um usuario, executar o mesmo fluxo:

1. limpar;
2. validar;
3. consultar duplicidade por CPF, se houver token/admin;
4. cadastrar;
5. retornar resultado.

## Formato de Resultado

Ao final, retornar uma tabela ou JSON com:

```text
Indice
Nome
CPF mascarado
Telefone mascarado
Status
Id criado
Email
Senha gerada ou usada
Mensagem
```

Status recomendados:

```text
CRIADO
JA_EXISTE
ERRO_VALIDACAO
ERRO_API
NAO_ENVIADO
```

Nao colar CPFs completos em respostas de chat, salvo se o ambiente e a politica permitirem explicitamente. Preferir CPF mascarado:

```text
123.***.***-01
```

## Exemplo de Requisicao

```powershell
$headers = @{
  Authorization = "Bearer <TOKEN>"
  "Content-Type" = "application/json; charset=utf-8"
  Accept = "application/json"
}

$body = @{
  nomeCompleto = "Maria Silva"
  email = $null
  senha = "Q7m@v2Lx9pZa"
  telefone = "38999999999"
  dataNascimento = "1990-05-15"
  cpf = "12345678901"
  contatoEmergenciaNome = "Joao Silva"
  contatoEmergenciaParentesco = "Pai"
  contatoEmergenciaTelefone = "38988888888"
  condicoesMedicas = "Nao informado"
} | ConvertTo-Json -Depth 10

Invoke-RestMethod `
  -Uri "https://vagantesmoc.com/api/user" `
  -Method POST `
  -Headers $headers `
  -Body ([System.Text.Encoding]::UTF8.GetBytes($body))
```

## Checklist Final

Antes de cadastrar:

- Token recebido e nao exposto.
- Endpoint sem barra final.
- Dados normalizados.
- CPF com 11 digitos.
- Telefones com 10 ou 11 digitos.
- Data em `AAAA-MM-DD`.
- Senha compativel com a regex.
- Resultado individual registrado.
