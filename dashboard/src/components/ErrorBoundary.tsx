import {
  Button,
  Card,
  CardBody,
  CodeBlock,
  CodeBlockCode,
  Content,
  Flex,
  FlexItem,
} from "@patternfly/react-core";
import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  title?: string;
}

interface State {
  error: Error | null;
}

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Unhandled UI error:", error, info.componentStack);
  }

  private handleRetry = () => {
    this.setState({ error: null });
  };

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <Card isGlass className="pf-v6-u-m-lg">
        <CardBody>
          <Content component="h2">{this.props.title || "Something went wrong"}</Content>
          <Content component="p">
            This page failed to render. The error has been logged to the browser console.
          </Content>
          <CodeBlock className="pf-v6-u-mt-md">
            <CodeBlockCode>{error.message}</CodeBlockCode>
          </CodeBlock>
          <Flex className="pf-v6-u-mt-md" gap={{ default: "gapSm" }}>
            <FlexItem>
              <Button variant="primary" onClick={this.handleRetry}>
                Try again
              </Button>
            </FlexItem>
            <FlexItem>
              <Button variant="secondary" onClick={() => window.location.reload()}>
                Reload page
              </Button>
            </FlexItem>
          </Flex>
        </CardBody>
      </Card>
    );
  }
}
